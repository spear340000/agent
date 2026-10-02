"""Lazy, local Qdrant indexing and retrieval for the legal corpora.

This module deliberately owns no long-lived Qdrant client.  A client is made
inside each operation and is closed in the operation's ``finally`` path.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
from itertools import chain
import json
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from legal_embeddings import Embedder
from legal_identity import law_id, parse_frontmatter, precedent_id


DEFAULT_MODEL = "nvidia/nemotron-3-embed-1b"
DEFAULT_DIMENSION = 2048


class VectorStoreUnavailable(RuntimeError):
    """The local vector snapshot is not safe to query in this operation."""


@dataclass(frozen=True, slots=True)
class VectorStoreConfig:
    path: Path = Path("data/qdrant")
    collection: str = "legal_vectors"
    model: str = DEFAULT_MODEL
    dimension: int = DEFAULT_DIMENSION

    def __post_init__(self) -> None:
        if not str(self.collection).strip():
            raise ValueError("collection must not be empty")
        if not str(self.model).strip():
            raise ValueError("model must not be empty")
        if self.dimension <= 0:
            raise ValueError("dimension must be positive")

    @property
    def manifest_path(self) -> Path:
        return self.path.parent / "vector_manifest.json"


@dataclass(frozen=True, slots=True)
class VectorBuildResult:
    documents: int
    points: int
    ready: bool
    fingerprint: str
    resumed: bool


ClientFactory = Callable[..., Any]


def deterministic_point_id(canonical_id: str, chunk_number: int = 0) -> str:
    """Return a stable Qdrant point ID independent of the host filesystem."""

    return str(uuid5(NAMESPACE_URL, f"{canonical_id}:{chunk_number}"))


def chunk_text(text: str, *, max_chars: int = 3000, overlap_chars: int = 300) -> list[str]:
    """Split one source document into bounded, overlapping embedding passages."""

    return list(_iter_chunks(text, max_chars=max_chars, overlap_chars=overlap_chars))


def _iter_chunks(
    text: str, *, max_chars: int = 3000, overlap_chars: int = 300
) -> Iterator[str]:
    """Yield bounded passages without allocating every chunk of one document."""

    if max_chars <= 0 or overlap_chars < 0 or overlap_chars >= max_chars:
        raise ValueError("chunk bounds must satisfy 0 <= overlap_chars < max_chars")
    normalized = text.strip()
    if not normalized:
        return
    step = max_chars - overlap_chars
    for start in range(0, len(normalized), step):
        chunk = normalized[start : start + max_chars]
        if chunk.strip():
            yield chunk


def _default_client_factory(config: VectorStoreConfig) -> QdrantClient:
    return QdrantClient(path=str(config.path), check_compatibility=False)


def _create_client(config: VectorStoreConfig, factory: ClientFactory | None) -> Any:
    selected = factory or _default_client_factory
    try:
        return selected(config)
    except TypeError as first_error:
        # Existing callers commonly provide a no-argument local-client factory.
        # Only use that compatibility form after the configured form was refused.
        try:
            return selected()
        except TypeError:
            raise first_error


@contextmanager
def _open_client(config: VectorStoreConfig, factory: ClientFactory | None) -> Iterator[Any]:
    client = _create_client(config, factory)
    try:
        yield client
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()


def _collection_names(client: Any) -> set[str]:
    return {str(item.name) for item in client.get_collections().collections}


def _collection_dimension(client: Any, collection: str) -> int | None:
    vectors = client.get_collection(collection).config.params.vectors
    if isinstance(vectors, Mapping):
        # Named-vector collections are not a valid snapshot for this store.
        return None
    size = getattr(vectors, "size", None)
    return int(size) if isinstance(size, int) else None


def _collection_count(client: Any, collection: str) -> int:
    counter = getattr(client, "count", None)
    if callable(counter):
        return int(counter(collection, exact=True).count)
    value = getattr(client.get_collection(collection), "points_count", 0)
    return int(value or 0)


def _read_manifest(config: VectorStoreConfig) -> dict[str, Any] | None:
    try:
        raw = json.loads(config.manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def _manifest_reason(manifest: Mapping[str, Any] | None, config: VectorStoreConfig) -> str | None:
    if manifest is None:
        return "vector manifest is unavailable"
    if manifest.get("ready") is not True:
        return "vector manifest is incomplete"
    if manifest.get("collection") != config.collection:
        return "manifest collection does not match configured collection"
    if manifest.get("model") != config.model:
        return "manifest model does not match configured model"
    if manifest.get("dimension") != config.dimension:
        return "manifest dimension does not match configured dimension"
    if not isinstance(manifest.get("fingerprint"), str) or not manifest["fingerprint"]:
        return "manifest fingerprint is missing"
    if not isinstance(manifest.get("point_count"), int) or manifest["point_count"] < 0:
        return "manifest point count is invalid"
    if (
        not isinstance(manifest.get("completed_documents"), int)
        or manifest["completed_documents"] < 0
    ):
        return "manifest completed document count is invalid"
    if "last_checkpoint" not in manifest or not isinstance(
        manifest["last_checkpoint"], (str, type(None))
    ):
        return "manifest completion checkpoint is invalid"
    return None


def _status_with_client(
    client: Any, config: VectorStoreConfig, manifest: Mapping[str, Any] | None
) -> dict[str, Any]:
    reason = _manifest_reason(manifest, config)
    status: dict[str, Any] = {
        "ready": False,
        "collection": config.collection,
        "model": config.model,
        "dimension": config.dimension,
        "points": 0,
        "reason": reason,
    }
    if reason is not None:
        return status
    if config.collection not in _collection_names(client):
        status["reason"] = "configured collection is unavailable"
        return status
    actual_dimension = _collection_dimension(client, config.collection)
    if actual_dimension != config.dimension:
        status["reason"] = (
            f"collection dimension {actual_dimension!r} does not match {config.dimension}"
        )
        return status
    count = _collection_count(client, config.collection)
    status["points"] = count
    expected = int(manifest["point_count"])
    if count != expected:
        status["reason"] = (
            f"collection point count {count} does not match manifest {expected}"
        )
        return status
    status["ready"] = True
    status["reason"] = None
    status["fingerprint"] = manifest["fingerprint"]
    return status


def vector_status(
    config: VectorStoreConfig, *, client_factory: ClientFactory | None = None
) -> dict[str, Any]:
    """Inspect the small manifest and compatible collection without scanning corpus data."""

    manifest = _read_manifest(config)
    # A missing or incomplete manifest is sufficient evidence that this store
    # is not queryable; avoid opening a large embedded collection in that case.
    reason = _manifest_reason(manifest, config)
    if reason is not None:
        return {
            "ready": False,
            "collection": config.collection,
            "model": config.model,
            "dimension": config.dimension,
            "points": 0,
            "reason": reason,
        }
    try:
        with _open_client(config, client_factory) as client:
            return _status_with_client(client, config, manifest)
    except Exception as exc:
        return {
            "ready": False,
            "collection": config.collection,
            "model": config.model,
            "dimension": config.dimension,
            "points": 0,
            "reason": f"Qdrant unavailable: {exc}",
        }


def search_vectors(
    query: str,
    *,
    embedder: Embedder,
    config: VectorStoreConfig,
    corpus: str | None = None,
    limit: int = 5,
    client_factory: ClientFactory | None = None,
) -> list[dict[str, Any]]:
    """Embed one query and return bounded, normalized payloads from Qdrant."""

    if not query.strip():
        raise ValueError("query must not be empty")
    if limit <= 0:
        raise ValueError("limit must be positive")
    manifest = _read_manifest(config)
    if _manifest_reason(manifest, config) is not None:
        raise VectorStoreUnavailable(_manifest_reason(manifest, config) or "unavailable")
    vector = embedder.embed([query], "query")
    if len(vector) != 1 or len(vector[0]) != config.dimension:
        raise VectorStoreUnavailable("query embedding does not match collection dimension")

    try:
        with _open_client(config, client_factory) as client:
            status = _status_with_client(client, config, manifest)
            if not status["ready"]:
                raise VectorStoreUnavailable(str(status["reason"]))
            query_filter = None
            if corpus is not None:
                query_filter = Filter(
                    must=[FieldCondition(key="corpus", match=MatchValue(value=corpus))]
                )
            response = client.query_points(
                collection_name=config.collection,
                query=vector[0],
                query_filter=query_filter,
                limit=limit,
                with_payload=True,
            )
            return [_normalize_hit(point) for point in response.points]
    except VectorStoreUnavailable:
        raise
    except Exception as exc:
        raise VectorStoreUnavailable(f"Qdrant unavailable: {exc}") from exc


def _normalize_hit(point: Any) -> dict[str, Any]:
    payload = dict(point.payload or {})
    title = str(payload.get("title") or payload.get("case_name") or "")
    return {
        "id": str(payload["id"]),
        "corpus": str(payload.get("corpus", "")),
        "title": title,
        "case_name": str(payload.get("case_name") or title),
        "source": str(payload.get("source") or payload.get("path") or ""),
        "excerpt": str(payload.get("excerpt") or payload.get("text") or "")[:1200],
        "chunk_number": int(payload.get("chunk_number", 0)),
        "vector_score": float(point.score),
    }


def build_vector_index(
    law_root: Path | None,
    precedent_root: Path | None,
    *,
    embedder: Embedder,
    config: VectorStoreConfig,
    resume: bool = True,
    batch_size: int = 16,
    client_factory: ClientFactory | None = None,
) -> VectorBuildResult:
    """Stream legal Markdown into a local Qdrant collection in bounded batches.

    A build starts by recording ``ready: false``.  It becomes queryable only
    after every upsert and the final collection point count agree with the
    committed manifest.
    """

    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    fingerprint = _corpus_fingerprint(law_root, precedent_root)
    prior = _read_manifest(config)
    if (
        prior is not None
        and prior.get("collection") == config.collection
        and prior.get("model") != config.model
    ):
        raise VectorStoreUnavailable("manifest model does not match configured model")
    resumed = bool(
        resume
        and prior
        and prior.get("fingerprint") == fingerprint
        and prior.get("collection") == config.collection
        and prior.get("model") == config.model
        and prior.get("dimension") == config.dimension
        and isinstance(prior.get("completed_documents"), int)
        and isinstance(prior.get("point_count"), int)
        and "last_checkpoint" in prior
    )
    completed_documents = int(prior["completed_documents"]) if resumed else 0
    indexed = int(prior["point_count"]) if resumed else 0
    last_checkpoint = prior["last_checkpoint"] if resumed else None
    _write_manifest(
        config,
        {
            "ready": False,
            "collection": config.collection,
            "model": config.model,
            "dimension": config.dimension,
            "fingerprint": fingerprint,
            "point_count": indexed,
            "completed_documents": completed_documents,
            "last_checkpoint": last_checkpoint,
        },
    )
    try:
        with _open_client(config, client_factory) as client:
            _ensure_collection(client, config, prior)
            if resumed and _collection_count(client, config.collection) < indexed:
                raise VectorStoreUnavailable("collection is missing checkpointed vector points")
            batch: list[dict[str, Any]] = []
            checkpoint_pending = last_checkpoint if resumed else None
            for document in _documents(law_root, precedent_root):
                if checkpoint_pending is not None:
                    if document["source"] != checkpoint_pending:
                        continue
                    checkpoint_pending = None
                    continue
                for chunk_number, excerpt in enumerate(_iter_chunks(document["text"])):
                    batch.append({**document, "chunk_number": chunk_number, "excerpt": excerpt})
                    if len(batch) >= batch_size:
                        indexed += _upsert_batch(client, batch, embedder, config)
                        batch = []
                # A checkpoint is stable only after every chunk belonging to
                # this document has reached Qdrant.  Otherwise a crash can
                # skip a document whose buffered points were never written.
                if batch:
                    indexed += _upsert_batch(client, batch, embedder, config)
                    batch = []
                completed_documents += 1
                last_checkpoint = document["source"]
                _write_manifest(
                    config,
                    {
                        "ready": False,
                        "collection": config.collection,
                        "model": config.model,
                        "dimension": config.dimension,
                        "fingerprint": fingerprint,
                        "point_count": indexed,
                        "completed_documents": completed_documents,
                        "last_checkpoint": last_checkpoint,
                    },
                )
            if checkpoint_pending is not None:
                raise VectorStoreUnavailable("manifest checkpoint is not present in this corpus")
            actual_count = _collection_count(client, config.collection)
            ready = actual_count == indexed
    except Exception:
        # The last persisted checkpoint remains explicitly incomplete.
        raise
    _write_manifest(
        config,
        {
            "ready": ready,
            "collection": config.collection,
            "model": config.model,
            "dimension": config.dimension,
            "fingerprint": fingerprint,
            "point_count": indexed,
            "completed_documents": completed_documents,
            "last_checkpoint": last_checkpoint,
        },
    )
    return VectorBuildResult(
        documents=completed_documents,
        points=indexed,
        ready=ready,
        fingerprint=fingerprint,
        resumed=resumed,
    )


def _ensure_collection(
    client: Any, config: VectorStoreConfig, manifest: Mapping[str, Any] | None
) -> None:
    names = _collection_names(client)
    if config.collection not in names:
        client.create_collection(
            config.collection,
            vectors_config=VectorParams(size=config.dimension, distance=Distance.COSINE),
        )
        return
    if (
        manifest is None
        or manifest.get("collection") != config.collection
        or manifest.get("model") != config.model
        or manifest.get("dimension") != config.dimension
    ):
        raise VectorStoreUnavailable("existing collection model cannot be validated")
    actual_dimension = _collection_dimension(client, config.collection)
    if actual_dimension != config.dimension:
        raise VectorStoreUnavailable(
            f"collection dimension {actual_dimension!r} does not match {config.dimension}"
        )


def _upsert_batch(
    client: Any, batch: Sequence[Mapping[str, Any]], embedder: Embedder, config: VectorStoreConfig
) -> int:
    vectors = embedder.embed([str(item["excerpt"]) for item in batch], "passage")
    if len(vectors) != len(batch) or any(len(vector) != config.dimension for vector in vectors):
        raise VectorStoreUnavailable("passage embedding does not match collection dimension")
    points = [
        PointStruct(
            id=deterministic_point_id(str(item["id"]), int(item["chunk_number"])),
            vector=vector,
            payload={
                "id": item["id"],
                "corpus": item["corpus"],
                "title": item["title"],
                "case_name": item["title"],
                "source": item["source"],
                "excerpt": item["excerpt"],
                "chunk_number": item["chunk_number"],
            },
        )
        for item, vector in zip(batch, vectors, strict=True)
    ]
    client.upsert(config.collection, points=points, wait=True)
    return len(points)


def _documents(
    law_root: Path | None, precedent_root: Path | None
) -> Iterator[dict[str, str]]:
    return chain(_iter_documents(law_root, "law"), _iter_documents(precedent_root, "precedent"))


def _iter_documents(root: Path | None, corpus: str) -> Iterator[dict[str, str]]:
    if root is None:
        return
    if not root.exists():
        raise FileNotFoundError(root)
    for path in sorted(root.rglob("*.md")):
        if path.name.casefold() == "readme.md":
            continue
        metadata, body = parse_frontmatter(path)
        relative = path.relative_to(root).as_posix()
        canonical_id = law_id(metadata, relative) if corpus == "law" else precedent_id(metadata, relative)
        title = _title(metadata, path)
        yield {
            "id": canonical_id,
            "corpus": corpus,
            "title": title,
            "source": path.as_posix(),
            "text": body,
        }


def _title(metadata: Mapping[str, Any], path: Path) -> str:
    for key in ("title", "case_name", "law_name", "법령명", "판례명"):
        value = metadata.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return path.stem


def _corpus_fingerprint(law_root: Path | None, precedent_root: Path | None) -> str:
    digest = hashlib.sha256()
    for document in _documents(law_root, precedent_root):
        for key in ("id", "corpus", "title", "source", "text"):
            digest.update(str(document[key]).encode("utf-8"))
            digest.update(b"\0")
    return digest.hexdigest()


def _write_manifest(config: VectorStoreConfig, data: Mapping[str, Any]) -> None:
    config.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config.manifest_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(dict(data), ensure_ascii=False, sort_keys=True), encoding="utf-8")
    temporary.replace(config.manifest_path)


__all__ = [
    "DEFAULT_DIMENSION",
    "DEFAULT_MODEL",
    "VectorBuildResult",
    "VectorStoreConfig",
    "VectorStoreUnavailable",
    "build_vector_index",
    "chunk_text",
    "deterministic_point_id",
    "search_vectors",
    "vector_status",
]
