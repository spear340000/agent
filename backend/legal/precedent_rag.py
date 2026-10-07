"""Backward-compatible precedent-vector API backed by the lazy shared store."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from legal_embeddings import Embedder, NvidiaEmbedder
from legal_vector import (
    DEFAULT_DIMENSION,
    DEFAULT_MODEL,
    VectorStoreConfig,
    build_vector_index,
    chunk_text,
    search_vectors,
)

PRECEDENT_DIR = Path(os.getenv("LEGAL_PRECEDENTS_ROOT", str(Path(os.getenv("LEGAL_DATA_ROOT", "data")) / "legal" / "precedent")))


def precedent_collection_name(model: str, dimension: int) -> str:
    """Preserve the collection spelling used by the original precedent index."""
    digest = hashlib.sha1(model.encode()).hexdigest()[:8]
    return f"precedents_{digest}_{dimension}"


def precedent_point_id(source: str) -> str:
    """Preserve legacy deterministic point IDs for callers that inspect them."""
    return str(uuid5(NAMESPACE_URL, source))


def chunk_precedent(text: str, max_chars: int = 3000, overlap_chars: int = 300) -> list[str]:
    return chunk_text(text, max_chars=max_chars, overlap_chars=overlap_chars)


def _precedent_config() -> VectorStoreConfig:
    return VectorStoreConfig(
        path=Path(os.getenv("QDRANT_PATH", "data/qdrant")),
        collection=precedent_collection_name(DEFAULT_MODEL, DEFAULT_DIMENSION),
        model=DEFAULT_MODEL,
        dimension=DEFAULT_DIMENSION,
    )


def build_precedent_index(
    batch_size: int = 16,
    progress=None,
    *,
    precedent_root: Path = PRECEDENT_DIR,
    embedder: Embedder | None = None,
    config: VectorStoreConfig | None = None,
    resume: bool = True,
    client_factory=None,
) -> int:
    """Build only precedents through the lazy shared vector store."""
    result = build_vector_index(
        None,
        precedent_root,
        embedder=embedder or NvidiaEmbedder(),
        config=config or _precedent_config(),
        resume=resume,
        batch_size=batch_size,
        client_factory=client_factory,
    )
    if progress is not None:
        progress(result.points)
    return result.points


def search_precedent_vectors(
    query: str,
    limit: int = 5,
    *,
    embedder: Embedder | None = None,
    config: VectorStoreConfig | None = None,
    client_factory=None,
) -> list[dict[str, Any]]:
    """Search precedents while retaining the legacy result fields and name."""
    hits = search_vectors(
        query,
        embedder=embedder or NvidiaEmbedder(),
        config=config or _precedent_config(),
        corpus="precedent",
        limit=limit,
        client_factory=client_factory,
    )
    return [
        {
            "id": hit["id"],
            "case_name": hit["case_name"],
            "path": hit["source"],
            "excerpt": hit["excerpt"],
            "vector_score": hit["vector_score"],
        }
        for hit in hits
    ]
