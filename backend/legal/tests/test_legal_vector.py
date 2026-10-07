from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from legal_vector import (
    VectorStoreConfig,
    VectorStoreUnavailable,
    build_vector_index,
    search_vectors,
    vector_status,
)


class FakeQdrant:
    """Small local-Qdrant double with the response shape this module consumes."""

    def __init__(self, dimension: int = 4) -> None:
        self.dimension = dimension
        self.closed = False
        self.created = False
        self.upserted = []
        self.points = []

    def factory(self, _config=None):
        return self

    def close(self) -> None:
        self.closed = True

    def get_collections(self):
        names = ["legal"] if self.created else []
        return SimpleNamespace(collections=[SimpleNamespace(name=name) for name in names])

    def get_collection(self, _collection):
        vectors = SimpleNamespace(size=self.dimension)
        return SimpleNamespace(
            config=SimpleNamespace(params=SimpleNamespace(vectors=vectors)),
            points_count=len(self.upserted),
        )

    def create_collection(self, _collection, vectors_config):
        self.dimension = vectors_config.size
        self.created = True

    def upsert(self, _collection, points, wait=True):
        self.upserted.extend(points)

    def count(self, _collection, exact=True):
        return SimpleNamespace(count=len(self.upserted))

    def query_points(self, **_kwargs):
        return SimpleNamespace(points=self.points)


class FakeEmbedder:
    def embed(self, texts, input_type):
        return [[float(index + 1)] * 4 for index, _text in enumerate(texts)]


def vector_config(tmp_path: Path) -> VectorStoreConfig:
    return VectorStoreConfig(
        path=tmp_path / "qdrant",
        collection="legal",
        model="test-model",
        dimension=4,
    )


def write_ready_manifest(config: VectorStoreConfig, *, points: int = 1) -> None:
    config.path.parent.mkdir(parents=True, exist_ok=True)
    (config.path.parent / "vector_manifest.json").write_text(
        json.dumps(
            {
                "ready": True,
                "collection": config.collection,
                "model": config.model,
                "dimension": config.dimension,
                "fingerprint": "fixture",
                "point_count": points,
                "completed_documents": points,
                "last_checkpoint": "fixture.md",
            }
        ),
        encoding="utf-8",
    )


def test_vector_search_returns_payload_and_closes_qdrant_client(tmp_path: Path):
    """Removing payload normalization or the finally close breaks this result."""
    config = vector_config(tmp_path)
    write_ready_manifest(config)
    qdrant = FakeQdrant()
    qdrant.created = True
    qdrant.upserted.append(object())
    qdrant.points = [
        SimpleNamespace(
            score=0.9,
            payload={
                "id": "precedent:151017",
                "corpus": "precedent",
                "case_name": "대법원 2024다1",
                "source": "precedent/case.md",
                "excerpt": "판결 요지",
                "chunk_number": 0,
            },
        )
    ]

    hits = search_vectors(
        "불법행위",
        embedder=FakeEmbedder(),
        config=config,
        corpus="precedent",
        limit=3,
        client_factory=qdrant.factory,
    )

    assert hits == [
        {
            "id": "precedent:151017",
            "corpus": "precedent",
            "title": "대법원 2024다1",
            "case_name": "대법원 2024다1",
            "source": "precedent/case.md",
            "excerpt": "판결 요지",
            "chunk_number": 0,
            "vector_score": 0.9,
        }
    ]
    assert qdrant.closed is True


def test_incompatible_collection_is_not_ready_and_is_closed(tmp_path: Path):
    """Changing the collection vector size must make a ready manifest unusable."""
    config = vector_config(tmp_path)
    write_ready_manifest(config)
    qdrant = FakeQdrant(dimension=3)
    qdrant.created = True
    qdrant.upserted.append(object())

    status = vector_status(config, client_factory=qdrant.factory)

    assert status["ready"] is False
    assert "dimension" in status["reason"]
    assert qdrant.closed is True


def test_build_writes_queryable_manifest_and_canonical_payloads(tmp_path: Path):
    """A partial build must not be ready; a completed stream has canonical payloads."""
    laws = tmp_path / "laws"
    precedents = tmp_path / "precedents"
    laws.mkdir()
    precedents.mkdir()
    (laws / "civil.md").write_text(
        "---\nlaw_id: '001'\ntitle: Civil Act\n---\nLaw body", encoding="utf-8"
    )
    (precedents / "case.md").write_text(
        "---\nprecedent_id: '151017'\ncase_name: Case A\n---\nCase body",
        encoding="utf-8",
    )
    config = vector_config(tmp_path)
    qdrant = FakeQdrant()

    result = build_vector_index(
        laws,
        precedents,
        embedder=FakeEmbedder(),
        config=config,
        batch_size=1,
        client_factory=qdrant.factory,
    )

    assert result.ready is True
    assert result.points == 2
    assert {point.payload["id"] for point in qdrant.upserted} == {
        "law:001",
        "precedent:151017",
    }
    assert {point.payload["corpus"] for point in qdrant.upserted} == {"law", "precedent"}
    assert qdrant.closed is True
    assert json.loads((tmp_path / "vector_manifest.json").read_text(encoding="utf-8"))["ready"] is True


def test_build_rejects_existing_collection_with_different_manifest_model(tmp_path: Path):
    """Changing only the model must stop before an existing collection is overwritten."""
    laws = tmp_path / "laws"
    laws.mkdir()
    (laws / "civil.md").write_text(
        "---\nlaw_id: '001'\ntitle: Civil Act\n---\nLaw body", encoding="utf-8"
    )
    first = VectorStoreConfig(tmp_path / "qdrant", "legal", "model-one", 4)
    second = VectorStoreConfig(tmp_path / "qdrant", "legal", "model-two", 4)
    qdrant = FakeQdrant()
    build_vector_index(laws, None, embedder=FakeEmbedder(), config=first, client_factory=qdrant.factory)

    with pytest.raises(VectorStoreUnavailable, match="model"):
        build_vector_index(laws, None, embedder=FakeEmbedder(), config=second, client_factory=qdrant.factory)


def test_resume_skips_checkpointed_documents_without_reembedding(tmp_path: Path):
    """An interrupted build must continue after its stable document checkpoint."""
    laws = tmp_path / "laws"
    laws.mkdir()
    (laws / "first.md").write_text(
        "---\nlaw_id: '001'\ntitle: First\n---\nfirst body", encoding="utf-8"
    )
    (laws / "second.md").write_text(
        "---\nlaw_id: '002'\ntitle: Second\n---\nsecond body", encoding="utf-8"
    )

    class InterruptingEmbedder(FakeEmbedder):
        def __init__(self) -> None:
            self.fail = True
            self.passages = []

        def embed(self, texts, input_type):
            self.passages.extend(texts)
            if self.fail and "second body" in texts[0]:
                raise RuntimeError("interrupted")
            return super().embed(texts, input_type)

    config = vector_config(tmp_path)
    qdrant = FakeQdrant()
    embedder = InterruptingEmbedder()
    with pytest.raises(RuntimeError, match="interrupted"):
        build_vector_index(
            laws, None, embedder=embedder, config=config, batch_size=16, client_factory=qdrant.factory
        )

    embedder.fail = False
    embedder.passages.clear()
    result = build_vector_index(
        laws, None, embedder=embedder, config=config, batch_size=16, client_factory=qdrant.factory
    )

    assert result.ready is True
    assert embedder.passages == ["second body"]


def test_qdrant_query_failure_becomes_vector_unavailable_and_closes(tmp_path: Path):
    """A locked local store must disable only the optional vector operation."""
    config = vector_config(tmp_path)
    write_ready_manifest(config)

    class LockedQdrant(FakeQdrant):
        def query_points(self, **_kwargs):
            raise RuntimeError("locked")

    qdrant = LockedQdrant()
    qdrant.created = True
    qdrant.upserted.append(object())
    with pytest.raises(VectorStoreUnavailable, match="Qdrant"):
        search_vectors(
            "불법행위",
            embedder=FakeEmbedder(),
            config=config,
            limit=1,
            client_factory=qdrant.factory,
        )
    assert qdrant.closed is True


def test_ready_manifest_requires_completion_checkpoint(tmp_path: Path):
    """A shortened ready manifest must never make an unknown partial build queryable."""
    config = vector_config(tmp_path)
    config.path.parent.mkdir(exist_ok=True)
    config.manifest_path.write_text(
        json.dumps(
            {
                "ready": True,
                "collection": config.collection,
                "model": config.model,
                "dimension": config.dimension,
                "fingerprint": "fixture",
                "point_count": 1,
            }
        ),
        encoding="utf-8",
    )

    status = vector_status(config, client_factory=FakeQdrant().factory)

    assert status["ready"] is False
    assert "completed" in status["reason"]
