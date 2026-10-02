import json
from pathlib import Path
from types import SimpleNamespace

from legal_vector import VectorStoreConfig
from precedent_rag import chunk_precedent, precedent_point_id, search_precedent_vectors


def test_precedent_point_id_is_stable_for_resume():
    assert precedent_point_id("data/legal/precedent/형사/대법원_2024.md") == precedent_point_id("data/legal/precedent/형사/대법원_2024.md")


def test_chunk_precedent_bounds_each_embedding_passage():
    chunks = chunk_precedent("word " * 900, max_chars=1000, overlap_chars=100)

    assert len(chunks) > 1
    assert all(len(chunk) <= 1000 for chunk in chunks)


def test_precedent_search_uses_lazy_compatible_vector_store(tmp_path: Path):
    """Removing the wrapper delegation would make legacy precedent search unusable."""
    config = VectorStoreConfig(tmp_path / "qdrant", "precedents", "test-model", 2)
    config.manifest_path.write_text(
        json.dumps(
            {
                "ready": True,
                "collection": "precedents",
                "model": "test-model",
                "dimension": 2,
                    "fingerprint": "fixture",
                    "point_count": 1,
                    "completed_documents": 1,
                    "last_checkpoint": "case.md",
                }
        ),
        encoding="utf-8",
    )

    class Embedder:
        def embed(self, texts, input_type):
            return [[0.0, 1.0]]

    class Client:
        def get_collections(self):
            return SimpleNamespace(collections=[SimpleNamespace(name="precedents")])

        def get_collection(self, _name):
            return SimpleNamespace(
                config=SimpleNamespace(params=SimpleNamespace(vectors=SimpleNamespace(size=2))),
                points_count=1,
            )

        def count(self, _name, exact=True):
            return SimpleNamespace(count=1)

        def query_points(self, **kwargs):
            return SimpleNamespace(
                points=[
                    SimpleNamespace(
                        score=0.8,
                        payload={
                            "id": "precedent:151017",
                            "corpus": "precedent",
                            "case_name": "Case A",
                            "source": "case.md",
                            "excerpt": "holding",
                            "chunk_number": 0,
                        },
                    )
                ]
            )

        def close(self):
            pass

    hits = search_precedent_vectors(
        "불법행위", embedder=Embedder(), config=config, client_factory=lambda: Client()
    )

    assert hits[0]["id"] == "precedent:151017"
    assert hits[0]["case_name"] == "Case A"
