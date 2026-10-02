"""Bounded lexical/vector/graph retrieval with deterministic rank fusion."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from legal_embeddings import EmbeddingUnavailable
from legal_vector import VectorStoreUnavailable


class RetrievalBackendUnavailable(RuntimeError):
    """One optional retrieval backend cannot serve the current request."""


@dataclass(frozen=True, slots=True)
class RetrievalCandidate:
    id: str
    title: str
    source: str
    excerpt: str
    channel: str
    rank: int
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class HybridSearchResult:
    query: str
    corpus: str
    results: list[dict[str, Any]]
    backends: dict[str, dict[str, Any]]


Backend = Callable[..., Sequence[Mapping[str, Any]]]
_AVAILABILITY_ERRORS = (
    RetrievalBackendUnavailable,
    EmbeddingUnavailable,
    VectorStoreUnavailable,
)


def reciprocal_rank_fusion(
    rankings: Mapping[str, Sequence[RetrievalCandidate]],
    *,
    limit: int,
    rank_constant: int = 60,
) -> list[dict[str, Any]]:
    if limit < 1:
        raise ValueError("limit must be positive")
    if rank_constant < 1:
        raise ValueError("rank_constant must be positive")

    merged: dict[str, dict[str, Any]] = {}
    for channel, candidates in rankings.items():
        for candidate in candidates:
            item = merged.setdefault(
                candidate.id,
                {
                    "id": candidate.id,
                    "title": candidate.title,
                    "source": candidate.source,
                    "excerpt": candidate.excerpt[:1200],
                    "channels": set(),
                    "ranks": {},
                    "fused_score": 0.0,
                    "graph_evidence": [],
                    "metadata": {},
                },
            )
            item["channels"].add(channel)
            item["ranks"][channel] = candidate.rank
            item["fused_score"] += 1.0 / (rank_constant + candidate.rank)
            if len(candidate.excerpt) > len(item["excerpt"]):
                item["excerpt"] = candidate.excerpt[:1200]
            if not item["title"] and candidate.title:
                item["title"] = candidate.title
            if not item["source"] and candidate.source:
                item["source"] = candidate.source
            if channel == "graph":
                evidence = candidate.metadata.get("path") or candidate.metadata.get(
                    "graph_evidence", []
                )
                for edge in evidence:
                    if edge not in item["graph_evidence"]:
                        item["graph_evidence"].append(edge)
            item["metadata"].update(candidate.metadata)

    results = list(merged.values())
    for item in results:
        item["channels"] = sorted(item["channels"])
        item["ranks"] = dict(sorted(item["ranks"].items()))
    results.sort(
        key=lambda item: (
            -item["fused_score"],
            min(item["ranks"].values()),
            item["id"],
        )
    )
    return results[:limit]


def _candidate(raw: Mapping[str, Any], channel: str, rank: int) -> RetrievalCandidate:
    identifier = str(raw.get("id") or raw.get("target_id") or "").strip()
    if not identifier:
        raise ValueError(f"{channel} result is missing id")
    title = str(
        raw.get("title")
        or raw.get("case_name")
        or raw.get("label")
        or raw.get("target_label")
        or identifier
    )
    source = str(raw.get("source") or raw.get("path_name") or raw.get("path_source") or "")
    excerpt = str(raw.get("excerpt") or raw.get("text") or raw.get("label") or title)
    core = {"id", "title", "case_name", "label", "source", "excerpt", "text"}
    metadata = {key: value for key, value in raw.items() if key not in core}
    return RetrievalCandidate(identifier, title, source, excerpt, channel, rank, metadata)


class HybridRetriever:
    def __init__(
        self,
        *,
        lexical: Backend,
        vector: Backend | None = None,
        graph: Backend | None = None,
    ) -> None:
        self._lexical = lexical
        self._vector = vector
        self._graph = graph

    def search(
        self,
        query: str,
        *,
        corpus: Literal["law", "precedent", "all"] = "all",
        limit: int = 5,
    ) -> HybridSearchResult:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be non-empty")
        if corpus not in {"law", "precedent", "all"}:
            raise ValueError("corpus must be law, precedent, or all")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
            raise ValueError("limit must be between 1 and 20")

        candidate_limit = min(limit * 3, 30)
        rankings: dict[str, list[RetrievalCandidate]] = {}
        backends: dict[str, dict[str, Any]] = {}

        lexical_raw = self._lexical(query.strip(), corpus, candidate_limit)
        rankings["lexical"] = [
            _candidate(item, "lexical", rank)
            for rank, item in enumerate(lexical_raw, start=1)
        ]
        backends["lexical"] = {"ready": True, "results": len(rankings["lexical"])}

        if self._vector is not None:
            try:
                vector_raw = self._vector(query.strip(), corpus, candidate_limit)
                rankings["vector"] = [
                    _candidate(item, "vector", rank)
                    for rank, item in enumerate(vector_raw, start=1)
                ]
                backends["vector"] = {"ready": True, "results": len(rankings["vector"])}
            except _AVAILABILITY_ERRORS as exc:
                backends["vector"] = {"ready": False, "reason": str(exc)}

        if self._graph is not None:
            seed_ids = list(
                dict.fromkeys(
                    candidate.id
                    for channel in ("lexical", "vector")
                    for candidate in rankings.get(channel, [])
                )
            )[:10]
            try:
                graph_raw = self._graph(query.strip(), seed_ids, candidate_limit)
                rankings["graph"] = [
                    _candidate(item, "graph", rank)
                    for rank, item in enumerate(graph_raw, start=1)
                ]
                backends["graph"] = {"ready": True, "results": len(rankings["graph"])}
            except _AVAILABILITY_ERRORS as exc:
                backends["graph"] = {"ready": False, "reason": str(exc)}

        return HybridSearchResult(
            query=query,
            corpus=corpus,
            results=reciprocal_rank_fusion(rankings, limit=limit),
            backends=backends,
        )


__all__ = [
    "HybridRetriever",
    "HybridSearchResult",
    "RetrievalBackendUnavailable",
    "RetrievalCandidate",
    "reciprocal_rank_fusion",
]
