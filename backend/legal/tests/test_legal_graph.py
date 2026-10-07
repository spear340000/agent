from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys
import shutil

import pytest
import legal_graph

from legal_graph import (
    build_graph,
    get_relations,
    graph_status,
    initialize_graph,
    search_graph,
)


@dataclass(frozen=True)
class FixtureCorpus:
    laws: Path
    precedents: Path


@pytest.fixture
def fixture_corpus() -> FixtureCorpus:
    root = Path(__file__).parent / "fixtures" / "legal_corpus"
    return FixtureCorpus(laws=root / "laws", precedents=root / "precedents")


def test_initialize_graph_enforces_normalized_foreign_key_schema(tmp_path: Path):
    """Removing a source node must not leave a dangling graph edge behind."""

    graph_path = tmp_path / "graph.sqlite3"
    initialize_graph(graph_path)

    with sqlite3.connect(graph_path) as connection:
        # SQLite foreign-key enforcement is connection-local.  The graph
        # module enables it on every connection it opens; this independent
        # inspection connection must do the same before exercising the schema.
        connection.execute("PRAGMA foreign_keys = ON")
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"nodes", "edges", "aliases", "metadata"} <= tables
        connection.execute(
            "INSERT INTO nodes(id, type, label) VALUES ('law:1', 'Law', 'Law')"
        )
        connection.execute(
            "INSERT INTO nodes(id, type, label) VALUES ('article:1', 'Article', 'Article')"
        )
        connection.execute(
            "INSERT INTO edges(source_id, relation, target_id) "
            "VALUES ('law:1', 'HAS_ARTICLE', 'article:1')"
        )
        connection.execute("DELETE FROM nodes WHERE id = 'law:1'")
        assert connection.execute("SELECT COUNT(*) FROM edges").fetchone()[0] == 0


def test_graph_operations_close_their_sqlite_handle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Leaving a builder connection open can lock the embedded graph for the next request."""

    real_connect = legal_graph.sqlite3.connect
    handles = []

    class TrackedConnection:
        def __init__(self, connection):
            self.connection = connection
            self.closed = False

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def close(self):
            self.closed = True
            self.connection.close()

    def tracked_connect(*args, **kwargs):
        handle = TrackedConnection(real_connect(*args, **kwargs))
        handles.append(handle)
        return handle

    monkeypatch.setattr(legal_graph.sqlite3, "connect", tracked_connect)
    legal_graph.initialize_graph(tmp_path / "graph.sqlite3")
    assert handles and handles[0].closed is True


def test_graph_builds_citation_path_and_resolves_case_alias(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """Dropping a direct statute citation or case-number alias loses graph evidence."""

    graph_path = tmp_path / "graph.sqlite3"
    result = build_graph(fixture_corpus.laws, fixture_corpus.precedents, graph_path)

    assert (result.laws, result.articles, result.precedents, result.courts) == (1, 2, 1, 1)
    paths = search_graph("불법행위 손해배상", graph_path=graph_path, limit=5)
    assert any(
        edge["relation"] == "CITES_ARTICLE"
        for hit in paths
        for edge in hit["path"]
    )
    relations = get_relations("2023다12345", graph_path=graph_path)
    assert any(
        item["relation"] == "CITES_ARTICLE"
        and item["target_label"] == "민법 제750조"
        for item in relations
    )
    status = graph_status(graph_path)
    assert status["ready"] is True
    assert status["nodes"] >= 6
    assert status["edges"] >= 6
    assert status["fingerprint"]


def test_graph_resume_skips_unchanged_files_without_duplicate_edges(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """Ignoring fingerprints would reprocess every source; losing edge uniqueness duplicates evidence."""

    graph_path = tmp_path / "graph.sqlite3"
    first = build_graph(fixture_corpus.laws, fixture_corpus.precedents, graph_path)
    second = build_graph(
        fixture_corpus.laws, fixture_corpus.precedents, graph_path, resume=True
    )

    assert second.skipped == 2
    assert second.processed == 0
    assert (second.nodes, second.edges) == (first.nodes, first.edges)
    with sqlite3.connect(graph_path) as connection:
        duplicate_edges = connection.execute(
            "SELECT COUNT(*) FROM ("
            "SELECT source_id, relation, target_id, COUNT(*) AS n FROM edges "
            "GROUP BY source_id, relation, target_id HAVING n > 1"
            ")"
        ).fetchone()[0]
    assert duplicate_edges == 0


def test_resume_removes_nodes_edges_aliases_for_a_deleted_source(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """A deleted statute must not remain queryable as live legal evidence after resume."""

    laws = tmp_path / "laws"
    precedents = tmp_path / "precedents"
    shutil.copytree(fixture_corpus.laws, laws)
    shutil.copytree(fixture_corpus.precedents, precedents)
    graph_path = tmp_path / "graph.sqlite3"
    first = build_graph(laws, precedents, graph_path)
    next(laws.rglob("*.md")).unlink()

    second = build_graph(laws, precedents, graph_path, resume=True)

    assert (second.laws, second.articles, second.precedents) == (0, 0, 1)
    assert get_relations("민법", graph_path=graph_path) == []
    assert not any(
        item["relation"] == "CITES_ARTICLE"
        for item in get_relations("2023다12345", graph_path=graph_path)
    )
    assert graph_status(graph_path)["fingerprint"] != first.fingerprint
    assert graph_status(graph_path)["ready"] is True


def test_changed_malformed_source_rolls_back_without_damaging_prior_graph(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """Clearing an old document before a bad replacement parses destroys valid evidence."""

    laws = tmp_path / "laws"
    precedents = tmp_path / "precedents"
    shutil.copytree(fixture_corpus.laws, laws)
    shutil.copytree(fixture_corpus.precedents, precedents)
    graph_path = tmp_path / "graph.sqlite3"
    build_graph(laws, precedents, graph_path)
    law_path = next(laws.rglob("*.md"))
    law_path.write_text("# invalid replacement\n", encoding="utf-8")

    result = build_graph(laws, precedents, graph_path, resume=True)

    assert result.errors >= 1
    assert any(item["relation"] == "HAS_ARTICLE" for item in get_relations("민법", graph_path=graph_path))


def test_failed_source_update_keeps_completed_fingerprint_and_marks_graph_stale(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """A new fingerprint after a parse failure falsely claims an incomplete snapshot is ready."""

    laws = tmp_path / "laws"
    precedents = tmp_path / "precedents"
    shutil.copytree(fixture_corpus.laws, laws)
    shutil.copytree(fixture_corpus.precedents, precedents)
    graph_path = tmp_path / "graph.sqlite3"
    first = build_graph(laws, precedents, graph_path)
    next(laws.rglob("*.md")).write_text("# malformed update\n", encoding="utf-8")

    failed = build_graph(laws, precedents, graph_path, resume=True)
    status = graph_status(graph_path)

    assert failed.errors >= 1
    assert failed.fingerprint == first.fingerprint
    assert status["fingerprint"] == first.fingerprint
    assert status["ready"] is False


def test_citation_pass_commits_each_requested_batch(
    tmp_path: Path, fixture_corpus: FixtureCorpus, monkeypatch: pytest.MonkeyPatch
):
    """One final citation commit keeps a full-corpus write transaction open indefinitely."""

    commits = 0
    original_connect = legal_graph._connect

    class CommitTrackingConnection:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def commit(self):
            nonlocal commits
            commits += 1
            self.connection.commit()

    @contextmanager
    def tracked_connect(path: Path):
        with original_connect(path) as connection:
            yield CommitTrackingConnection(connection)

    monkeypatch.setattr(legal_graph, "_connect", tracked_connect)
    build_graph(fixture_corpus.laws, fixture_corpus.precedents, tmp_path / "graph.sqlite3", batch_size=1)

    # Two document writes, two citation writes, and the completed-snapshot
    # metadata commit are each required with a batch size of one.
    assert commits >= 5


def test_traversal_rejects_unbounded_arguments(tmp_path: Path):
    """Allowing a third hop turns query-time evidence lookup into an unbounded crawl."""

    graph_path = tmp_path / "graph.sqlite3"
    with pytest.raises(ValueError, match="max_hops"):
        search_graph("민법", graph_path=graph_path, max_hops=3)
    with pytest.raises(ValueError, match="limit"):
        get_relations("law:1", graph_path=graph_path, limit=0)


def test_build_command_writes_a_fixture_graph(
    tmp_path: Path, fixture_corpus: FixtureCorpus
):
    """A CLI that silently skips the requested corpus leaves no usable graph artifact."""

    graph_path = tmp_path / "graph.sqlite3"
    result = subprocess.run(
        [
            sys.executable,
            "build_legal_graph.py",
            "--laws",
            str(fixture_corpus.laws),
            "--precedents",
            str(fixture_corpus.precedents),
            "--graph",
            str(graph_path),
            "--resume",
            "--batch-size",
            "1",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert graph_status(graph_path)["ready"] is True
