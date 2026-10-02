"""Memory-bounded read-only index for the existing local Qdrant snapshot."""

from __future__ import annotations

import json
from pathlib import Path
import pickle
import sqlite3
from typing import Any

import numpy as np


DATA_ROOT = Path(os.getenv("LEGAL_DATA_ROOT", "data"))
DEFAULT_SOURCE = Path(os.getenv("LEGAL_VECTOR_SOURCE", str(DATA_ROOT / "qdrant" / "collection" / "knowledge_50353861_2048" / "storage.sqlite")))
DEFAULT_ROOT = Path(os.getenv("VECTOR_MEMMAP_PATH", str(DATA_ROOT / "vector_memmap")))
DIMENSION = 2048
CHUNK_ROWS = 2048


def _paths(root: Path) -> tuple[Path, Path, Path]:
    return root / "vectors.float32", root / "metadata.sqlite3", root / "manifest.json"


def build_index(source: Path = DEFAULT_SOURCE, root: Path = DEFAULT_ROOT) -> dict[str, Any]:
    """Stream Qdrant PointStruct blobs into a bounded memmap + metadata DB."""

    root.mkdir(parents=True, exist_ok=True)
    vector_path, metadata_path, manifest_path = _paths(root)
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        count = int(source_connection.execute("SELECT COUNT(*) FROM points").fetchone()[0])
        if count <= 0:
            raise ValueError("legacy Qdrant collection is empty")
        temporary_vectors = vector_path.with_suffix(".tmp")
        temporary_metadata = metadata_path.with_suffix(".tmp")
        for path in (temporary_vectors, temporary_metadata):
            path.unlink(missing_ok=True)
        vectors = np.memmap(temporary_vectors, mode="w+", dtype="float32", shape=(count, DIMENSION))
        metadata = sqlite3.connect(temporary_metadata)
        metadata.execute("CREATE TABLE hits (rowid INTEGER PRIMARY KEY, id TEXT, source TEXT, title TEXT, text TEXT)")
        metadata.execute("CREATE INDEX hits_id_idx ON hits(id)")
        for row_number, (blob,) in enumerate(source_connection.execute("SELECT point FROM points ORDER BY rowid")):
            point = pickle.loads(blob)
            vector = np.asarray(point.vector, dtype=np.float32)
            if vector.shape != (DIMENSION,) or not np.isfinite(vector).all():
                raise ValueError(f"invalid vector at row {row_number}")
            vectors[row_number] = vector
            payload = point.payload or {}
            metadata.execute(
                "INSERT INTO hits(rowid,id,source,title,text) VALUES (?,?,?,?,?)",
                (row_number, str(point.id), str(payload.get("source", "")), str(payload.get("title", "")), str(payload.get("text", ""))),
            )
            if (row_number + 1) % 1000 == 0:
                metadata.commit()
        vectors.flush()
        metadata.commit()
        metadata.close()
        del vectors
        temporary_vectors.replace(vector_path)
        temporary_metadata.replace(metadata_path)
        manifest = {"ready": True, "rows": count, "dimension": DIMENSION, "source": str(source)}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest
    finally:
        source_connection.close()


def status(root: Path = DEFAULT_ROOT) -> dict[str, Any]:
    vector_path, metadata_path, manifest_path = _paths(root)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        rows = int(manifest["rows"])
        ready = bool(manifest.get("ready")) and vector_path.stat().st_size == rows * DIMENSION * 4 and metadata_path.is_file()
        return {"ready": ready, "backend": "memmap", "rows": rows, "dimension": DIMENSION, "path": str(root)}
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return {"ready": False, "backend": "memmap", "rows": 0, "dimension": DIMENSION, "path": str(root)}


def search(query_vector: list[float] | np.ndarray, *, limit: int = 5, root: Path = DEFAULT_ROOT) -> list[dict[str, Any]]:
    state = status(root)
    if not state["ready"]:
        raise RuntimeError("memory-bounded vector index is not built")
    query = np.asarray(query_vector, dtype=np.float32)
    if query.shape != (DIMENSION,):
        raise ValueError(f"query vector must have dimension {DIMENSION}")
    norm = float(np.linalg.norm(query))
    if not np.isfinite(norm) or norm == 0:
        raise ValueError("query vector must be finite and non-zero")
    query = query / norm
    vectors = np.memmap(_paths(root)[0], mode="r", dtype="float32", shape=(state["rows"], DIMENSION))
    best_scores = np.full(limit, -np.inf, dtype=np.float32)
    best_rows = np.full(limit, -1, dtype=np.int64)
    for start in range(0, state["rows"], CHUNK_ROWS):
        scores = np.asarray(vectors[start : start + CHUNK_ROWS] @ query)
        take = min(limit, len(scores))
        indices = np.argpartition(scores, -take)[-take:]
        merged_scores = np.concatenate((best_scores, scores[indices]))
        merged_rows = np.concatenate((best_rows, indices.astype(np.int64) + start))
        selected = np.argsort(merged_scores)[-limit:][::-1]
        best_scores, best_rows = merged_scores[selected], merged_rows[selected]
    del vectors
    connection = sqlite3.connect(_paths(root)[1])
    try:
        results = []
        for row, score in zip(best_rows, best_scores):
            if row < 0:
                continue
            item = connection.execute("SELECT id,source,title,text FROM hits WHERE rowid = ?", (int(row),)).fetchone()
            if item:
                results.append({"id": item[0], "source": item[1], "title": item[2], "excerpt": item[3][:1200], "vector_score": float(score), "corpus": "law"})
        return results
    finally:
        connection.close()
