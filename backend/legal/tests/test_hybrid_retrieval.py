from __future__ import annotations

from hybrid_retrieval import (
    HybridRetriever,
    RetrievalCandidate,
    reciprocal_rank_fusion,
)
from legal_vector import VectorStoreUnavailable


def candidate(identifier: str, channel: str, rank: int, **metadata):
    return RetrievalCandidate(
        id=identifier,
        title=metadata.pop("title", identifier),
        source=metadata.pop("source", f"{identifier}.md"),
        excerpt=metadata.pop("excerpt", identifier),
        channel=channel,
        rank=rank,
        metadata=metadata,
    )


def test_rrf_deduplicates_and_preserves_graph_evidence():
    evidence = [{"relation": "CITES_ARTICLE", "target_id": "law:1:article:750"}]
    results = reciprocal_rank_fusion(
        {
            "lexical": [candidate("law:1", "lexical", 1)],
            "vector": [
                candidate("precedent:2", "vector", 1),
                candidate("law:1", "vector", 2),
            ],
            "graph": [candidate("law:1", "graph", 1, path=evidence)],
        },
        limit=5,
    )

    assert results[0]["id"] == "law:1"
    assert results[0]["channels"] == ["graph", "lexical", "vector"]
    assert results[0]["ranks"] == {"graph": 1, "lexical": 1, "vector": 2}
    assert results[0]["graph_evidence"] == evidence


def test_hybrid_search_degrades_when_vector_is_unavailable():
    calls = {}

    def lexical(query, corpus, limit):
        calls["lexical_limit"] = limit
        return [{"id": "law:1", "title": "민법", "source": "civil.md", "excerpt": query}]

    def vector(query, corpus, limit):
        raise VectorStoreUnavailable("locked")

    def graph(query, seed_ids, limit):
        calls["seeds"] = seed_ids
        return [{"id": "law:1", "label": "민법", "path": [{"relation": "HAS_ARTICLE"}]}]

    result = HybridRetriever(lexical=lexical, vector=vector, graph=graph).search(
        "민법 불법행위", corpus="all", limit=5
    )

    assert result.results[0]["id"] == "law:1"
    assert result.backends["lexical"]["ready"] is True
    assert result.backends["vector"] == {"ready": False, "reason": "locked"}
    assert calls["lexical_limit"] == 15
    assert calls["seeds"] == ["law:1"]


def test_hybrid_search_rejects_invalid_bounds():
    retriever = HybridRetriever(lexical=lambda *_args, **_kwargs: [])
    for bad_limit in (0, 21):
        try:
            retriever.search("민법", corpus="all", limit=bad_limit)
        except ValueError as exc:
            assert "limit" in str(exc)
        else:
            raise AssertionError("invalid limit was accepted")
