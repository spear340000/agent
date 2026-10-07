"""Persistent, bounded SQLite graph support for Korean legal sources.

The builder intentionally processes one Markdown document at a time.  The
database is the graph; neither the corpus nor an in-memory object graph is
retained between documents or queries.
"""

from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Any, Iterator, Sequence
import unicodedata

from legal_identity import (
    article_id,
    document_aliases,
    extract_citations,
    law_id,
    parse_frontmatter,
    precedent_id,
)


_MAX_HOPS = 2
_MAX_LIMIT = 100
_ARTICLE_HEADING = re.compile(
    r"(?m)^\s*#{1,6}\s*(?P<number>제\s*\d+(?:\s*조의\s*\d+)?\s*조)"
    r"(?:\s*\((?P<title>[^)]*)\))?"
)
_WORD = re.compile(r"[0-9A-Za-z가-힣]+")


@dataclass(frozen=True, slots=True)
class GraphBuildResult:
    laws: int
    articles: int
    precedents: int
    courts: int
    concepts: int
    nodes: int
    edges: int
    processed: int
    skipped: int
    errors: int
    fingerprint: str


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
    finally:
        connection.close()


def initialize_graph(path: Path) -> None:
    """Create the normalized graph schema without opening any source corpus."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS nodes (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL,
              label TEXT NOT NULL,
              properties_json TEXT NOT NULL DEFAULT '{}',
              source_id TEXT
            );
            CREATE TABLE IF NOT EXISTS edges (
              source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
              relation TEXT NOT NULL,
              target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
              properties_json TEXT NOT NULL DEFAULT '{}',
              PRIMARY KEY (source_id, relation, target_id)
            );
            CREATE TABLE IF NOT EXISTS aliases (
              alias TEXT NOT NULL,
              node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
              PRIMARY KEY (alias, node_id)
            );
            CREATE TABLE IF NOT EXISTS metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS nodes_type_label_idx ON nodes(type, label);
            CREATE INDEX IF NOT EXISTS edges_source_relation_idx ON edges(source_id, relation);
            CREATE INDEX IF NOT EXISTS edges_target_relation_idx ON edges(target_id, relation);
            CREATE INDEX IF NOT EXISTS aliases_alias_idx ON aliases(alias);
            CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, label);
            CREATE VIRTUAL TABLE IF NOT EXISTS aliases_fts USING fts5(node_id UNINDEXED, alias);
            """
        )


def _iter_markdown(root: Path) -> Iterator[Path]:
    if not root.is_dir():
        return
    for directory, directories, files in os.walk(root):
        directories.sort()
        for name in sorted(files):
            if name.lower().endswith(".md") and name.lower() != "readme.md":
                yield Path(directory) / name


def _relative_path(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _file_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_id(prefix: str, value: str) -> str:
    normalized = unicodedata.normalize("NFC", value).strip()
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}:{digest}"


def _text(metadata: dict[str, Any], *keys: str, default: str) -> str:
    for key in keys:
        value = metadata.get(key)
        if value is not None and str(value).strip():
            return unicodedata.normalize("NFC", str(value)).strip()
    return default


def _article_records(body: str) -> list[tuple[str, str, str]]:
    matches = list(_ARTICLE_HEADING.finditer(body))
    records: list[tuple[str, str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        number = re.sub(r"\s+", "", match.group("number"))
        title = (match.group("title") or "").strip()
        records.append((number, title, body[match.end() : end].strip()))
    return records


def _upsert_node(
    connection: sqlite3.Connection,
    node_id: str,
    node_type: str,
    label: str,
    properties: dict[str, Any],
    source_id: str | None,
) -> None:
    connection.execute(
        """
        INSERT INTO nodes(id, type, label, properties_json, source_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type, label = excluded.label,
          properties_json = excluded.properties_json, source_id = excluded.source_id
        """,
        (node_id, node_type, label, json.dumps(properties, ensure_ascii=False, sort_keys=True), source_id),
    )


def _add_edge(
    connection: sqlite3.Connection,
    source_id: str,
    relation: str,
    target_id: str,
    properties: dict[str, Any] | None = None,
) -> None:
    connection.execute(
        "INSERT OR IGNORE INTO edges(source_id, relation, target_id, properties_json) VALUES (?, ?, ?, ?)",
        (source_id, relation, target_id, json.dumps(properties or {}, ensure_ascii=False, sort_keys=True)),
    )


def _record_key(kind: str, relative_path: str) -> str:
    return f"document:{kind}:{relative_path}"


def _load_record(connection: sqlite3.Connection, key: str) -> dict[str, Any] | None:
    row = connection.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row[0])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _clear_changed_document(connection: sqlite3.Connection, record: dict[str, Any]) -> None:
    old_ids = [item for item in record.get("nodes", []) if isinstance(item, str)]
    if not old_ids:
        return
    placeholders = ", ".join("?" for _ in old_ids)
    connection.execute(f"DELETE FROM edges WHERE source_id IN ({placeholders})", old_ids)
    connection.execute(f"DELETE FROM aliases WHERE node_id IN ({placeholders})", old_ids)


def _delete_document_record(
    connection: sqlite3.Connection, key: str, record: dict[str, Any]
) -> None:
    """Remove every graph artifact owned by a source document."""

    old_ids = [item for item in record.get("nodes", []) if isinstance(item, str)]
    for node_id in old_ids:
        connection.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
    connection.execute("DELETE FROM metadata WHERE key = ?", (key,))


def _write_document(
    connection: sqlite3.Connection,
    *,
    kind: str,
    root: Path,
    path: Path,
    fingerprint: str,
) -> None:
    relative = _relative_path(root, path)
    key = _record_key(kind, relative)
    old_record = _load_record(connection, key)
    if old_record:
        _clear_changed_document(connection, old_record)

    metadata, body = parse_frontmatter(path)
    source_id = _stable_id("source", f"{kind}/{relative}")
    _upsert_node(
        connection,
        source_id,
        "Source",
        relative,
        {"corpus": kind, "path": relative, "fingerprint": fingerprint},
        None,
    )
    owned_ids = [source_id]

    if kind == "law":
        node_id = law_id(metadata, relative)
        label = _text(metadata, "법령명", "법령이름", "law_name", "title", default=path.stem)
        _upsert_node(connection, node_id, "Law", label, {"path": relative}, source_id)
        _add_edge(connection, node_id, "DERIVED_FROM", source_id)
        owned_ids.append(node_id)
        aliases = set(document_aliases(metadata, path)) | {relative, label, node_id}
        for alias in aliases:
            connection.execute("INSERT OR IGNORE INTO aliases(alias, node_id) VALUES (?, ?)", (alias, node_id))

        for number, title, article_text in _article_records(body):
            child_id = article_id(node_id, number)
            article_label = f"{label} {number}"
            _upsert_node(
                connection,
                child_id,
                "Article",
                article_label,
                {"number": number, "title": title, "path": relative},
                source_id,
            )
            _add_edge(connection, node_id, "HAS_ARTICLE", child_id)
            _add_edge(connection, child_id, "DERIVED_FROM", source_id)
            connection.execute("INSERT OR IGNORE INTO aliases(alias, node_id) VALUES (?, ?)", (article_label, child_id))
            owned_ids.append(child_id)
    else:
        node_id = precedent_id(metadata, relative)
        label = _text(metadata, "title", "사건명", "판례명", default=path.stem)
        _upsert_node(connection, node_id, "Precedent", label, {"path": relative}, source_id)
        _add_edge(connection, node_id, "DERIVED_FROM", source_id)
        owned_ids.append(node_id)
        aliases = set(document_aliases(metadata, path)) | {relative, label, node_id}
        for alias in aliases:
            connection.execute("INSERT OR IGNORE INTO aliases(alias, node_id) VALUES (?, ?)", (alias, node_id))

        court = _text(metadata, "법원명", "court", default="")
        if court:
            court_id = _stable_id("court", court)
            _upsert_node(connection, court_id, "Court", court, {}, None)
            _add_edge(connection, node_id, "DECIDED_BY", court_id)
        if "불법행위" in body:
            concept = "불법행위"
            concept_id = _stable_id("concept", concept)
            _upsert_node(connection, concept_id, "LegalConcept", concept, {}, None)
            _add_edge(connection, node_id, "RELATES_TO", concept_id)

    if old_record:
        stale = set(old_record.get("nodes", [])) - set(owned_ids)
        for node_id in stale:
            connection.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
    connection.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
        (key, json.dumps({"fingerprint": fingerprint, "nodes": owned_ids}, sort_keys=True)),
    )


def _resolve_law(connection: sqlite3.Connection, label: str) -> str | None:
    row = connection.execute(
        """
        SELECT n.id FROM aliases AS a JOIN nodes AS n ON n.id = a.node_id
        WHERE a.alias = ? AND n.type = 'Law' LIMIT 1
        """,
        (label,),
    ).fetchone()
    if row is None:
        row = connection.execute(
            "SELECT id FROM nodes WHERE type = 'Law' AND label = ? LIMIT 1", (label,)
        ).fetchone()
    return str(row[0]) if row else None


def _add_citations_for_document(
    connection: sqlite3.Connection, *, kind: str, root: Path, path: Path
) -> None:
    relative = _relative_path(root, path)
    record = _load_record(connection, _record_key(kind, relative))
    if not record:
        return
    metadata, body = parse_frontmatter(path)
    if kind == "law":
        parent = law_id(metadata, relative)
        sources = [(parent, body)]
        sources.extend((article_id(parent, number), text) for number, _, text in _article_records(body))
    else:
        sources = [(precedent_id(metadata, relative), body)]

    for source_id, text in sources:
        exists = connection.execute("SELECT 1 FROM nodes WHERE id = ? LIMIT 1", (source_id,)).fetchone()
        if not exists:
            continue
        for citation in extract_citations(text):
            target_law = _resolve_law(connection, citation.law_name)
            if target_law is None:
                continue
            try:
                target_article = article_id(target_law, citation.article_number)
            except ValueError:
                continue
            target_exists = connection.execute(
                "SELECT 1 FROM nodes WHERE id = ? LIMIT 1", (target_article,)
            ).fetchone()
            relation = "CITES_ARTICLE" if target_exists else "CITES_LAW"
            _add_edge(
                connection,
                source_id,
                relation,
                target_article if target_exists else target_law,
                {"law_name": citation.law_name, "article_number": citation.article_number},
            )


def _count(connection: sqlite3.Connection, table: str, where: str = "", values: tuple[Any, ...] = ()) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM {table} {where}", values).fetchone()[0])


def build_graph(
    law_root: Path,
    precedent_root: Path,
    graph_path: Path,
    *,
    resume: bool = True,
    batch_size: int = 250,
) -> GraphBuildResult:
    """Stream legal Markdown into SQLite, committing at bounded source batches."""

    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    initialize_graph(graph_path)
    processed = skipped = errors = since_commit = 0
    error_log = graph_path.with_name(f"{graph_path.stem}-build-errors.log")
    corpus_fingerprint = hashlib.sha256()
    with _connect(graph_path) as connection:
        previous_fingerprint_row = connection.execute(
            "SELECT value FROM metadata WHERE key = 'corpus_fingerprint' LIMIT 1"
        ).fetchone()
        previous_fingerprint = (
            str(previous_fingerprint_row[0]) if previous_fingerprint_row else ""
        )
        connection.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('build_ready', 'false')"
        )
        connection.execute(
            "CREATE TEMP TABLE seen_documents(key TEXT PRIMARY KEY)"
        )
        connection.commit()
        for kind, root in (("law", law_root), ("precedent", precedent_root)):
            for path in _iter_markdown(root):
                relative = _relative_path(root, path)
                record_key = _record_key(kind, relative)
                connection.execute(
                    "INSERT OR IGNORE INTO seen_documents(key) VALUES (?)", (record_key,)
                )
                fingerprint = _file_fingerprint(path)
                corpus_fingerprint.update(f"{kind}/{relative}\0{fingerprint}\n".encode("utf-8"))
                previous = _load_record(connection, record_key)
                if resume and previous and previous.get("fingerprint") == fingerprint:
                    skipped += 1
                    continue
                connection.execute("SAVEPOINT document_write")
                try:
                    _write_document(
                        connection, kind=kind, root=root, path=path, fingerprint=fingerprint
                    )
                except (OSError, UnicodeError, ValueError) as exc:
                    connection.execute("ROLLBACK TO SAVEPOINT document_write")
                    connection.execute("RELEASE SAVEPOINT document_write")
                    errors += 1
                    with error_log.open("a", encoding="utf-8") as log:
                        log.write(f"{kind}\t{path}\t{type(exc).__name__}: {exc}\n")
                    continue
                connection.execute("RELEASE SAVEPOINT document_write")
                processed += 1
                since_commit += 1
                if since_commit >= batch_size:
                    connection.commit()
                    since_commit = 0

        # Remove sources that disappeared since the previous completed build.
        while True:
            stale_rows = connection.execute(
                """
                SELECT key, value FROM metadata
                WHERE key LIKE 'document:%'
                  AND key NOT IN (SELECT key FROM seen_documents)
                ORDER BY key
                LIMIT ?
                """,
                (batch_size,),
            ).fetchall()
            if not stale_rows:
                break
            for row in stale_rows:
                try:
                    record = json.loads(row["value"])
                except (json.JSONDecodeError, TypeError):
                    record = {}
                _delete_document_record(connection, str(row["key"]), record)
            connection.commit()

        # A second streaming pass adds citations only after every potential
        # target law/article exists.  It stores no document bodies.
        citation_since_commit = 0
        for kind, root in (("law", law_root), ("precedent", precedent_root)):
            for path in _iter_markdown(root):
                try:
                    _add_citations_for_document(connection, kind=kind, root=root, path=path)
                except (OSError, UnicodeError, ValueError) as exc:
                    errors += 1
                    with error_log.open("a", encoding="utf-8") as log:
                        log.write(f"citation\t{kind}\t{path}\t{type(exc).__name__}: {exc}\n")
                citation_since_commit += 1
                if citation_since_commit >= batch_size:
                    connection.commit()
                    citation_since_commit = 0
        candidate_fingerprint = corpus_fingerprint.hexdigest()
        if errors == 0:
            fingerprint = candidate_fingerprint
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES ('corpus_fingerprint', ?)",
                (fingerprint,),
            )
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES ('build_ready', 'true')"
            )
        else:
            fingerprint = previous_fingerprint
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES ('build_ready', 'false')"
            )
        connection.commit()
        return GraphBuildResult(
            laws=_count(connection, "nodes", "WHERE type = ?", ("Law",)),
            articles=_count(connection, "nodes", "WHERE type = ?", ("Article",)),
            precedents=_count(connection, "nodes", "WHERE type = ?", ("Precedent",)),
            courts=_count(connection, "nodes", "WHERE type = ?", ("Court",)),
            concepts=_count(connection, "nodes", "WHERE type = ?", ("LegalConcept",)),
            nodes=_count(connection, "nodes"),
            edges=_count(connection, "edges"),
            processed=processed,
            skipped=skipped,
            errors=errors,
            fingerprint=fingerprint,
        )


def _validate_bounds(max_hops: int, limit: int) -> None:
    if not 0 <= max_hops <= _MAX_HOPS:
        raise ValueError(f"max_hops must be between 0 and {_MAX_HOPS}")
    if not 1 <= limit <= _MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {_MAX_LIMIT}")


def _resolve_identifier(connection: sqlite3.Connection, identifier: str, limit: int) -> list[str]:
    direct = connection.execute("SELECT id FROM nodes WHERE id = ? LIMIT ?", (identifier, limit)).fetchall()
    aliases = connection.execute(
        "SELECT node_id FROM aliases WHERE alias = ? LIMIT ?", (identifier, limit)
    ).fetchall()
    return list(dict.fromkeys([str(row[0]) for row in [*direct, *aliases]]))[:limit]


def _edge_rows(connection: sqlite3.Connection, source_id: str, limit: int) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT e.source_id, e.relation, e.target_id, e.properties_json,
               source.label AS source_label, target.label AS target_label, target.type AS target_type
        FROM edges AS e
        JOIN nodes AS source ON source.id = e.source_id
        JOIN nodes AS target ON target.id = e.target_id
        WHERE e.source_id = ?
        ORDER BY e.relation, e.target_id
        LIMIT ?
        """,
        (source_id, limit),
    ).fetchall()


def _edge_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "source_id": str(row["source_id"]),
        "source_label": str(row["source_label"]),
        "relation": str(row["relation"]),
        "target_id": str(row["target_id"]),
        "target_label": str(row["target_label"]),
        "target_type": str(row["target_type"]),
        "properties": json.loads(row["properties_json"]),
    }


def get_relations(
    identifier: str, *, graph_path: Path, max_hops: int = 1, limit: int = 20
) -> list[dict]:
    """Return explicitly stored outgoing evidence paths for one ID or alias."""

    _validate_bounds(max_hops, limit)
    if not graph_path.is_file():
        return []
    with _connect(graph_path) as connection:
        frontier = [(node_id, []) for node_id in _resolve_identifier(connection, identifier, limit)]
        seen = {node_id for node_id, _ in frontier}
        results: list[dict] = []
        for _ in range(max_hops):
            next_frontier: list[tuple[str, list[dict[str, Any]]]] = []
            for source_id, path in frontier:
                remaining = limit - len(results)
                if remaining <= 0:
                    return results
                for row in _edge_rows(connection, source_id, remaining):
                    edge = _edge_dict(row)
                    evidence = [*path, edge]
                    results.append({**edge, "path": evidence})
                    if edge["target_id"] not in seen:
                        seen.add(edge["target_id"])
                        next_frontier.append((edge["target_id"], evidence))
            frontier = next_frontier
            if not frontier:
                break
        return results


def _query_seeds(connection: sqlite3.Connection, query: str, limit: int) -> list[str]:
    seeds = _resolve_identifier(connection, query, limit)
    tokens = _WORD.findall(unicodedata.normalize("NFC", query))[:8]
    try:
        fts_query = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
        rows = connection.execute(
            "SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT ?", (fts_query, limit)
        ).fetchall()
    except sqlite3.OperationalError:
        rows = connection.execute(
            "SELECT id FROM nodes WHERE label LIKE ? ORDER BY id LIMIT ?", (f"%{tokens[0]}%", limit)
        ).fetchall() if tokens else []
    for token in tokens:
        try:
            alias_rows = connection.execute(
                "SELECT node_id FROM aliases_fts WHERE aliases_fts MATCH ? LIMIT ?",
                (f'"{token.replace(chr(34), chr(34) * 2)}"', limit),
            ).fetchall()
        except sqlite3.OperationalError:
            alias_rows = connection.execute(
                "SELECT node_id FROM aliases WHERE alias LIKE ? ORDER BY node_id LIMIT ?",
                (f"%{token}%", limit),
            ).fetchall()
        seeds.extend(str(row[0]) for row in [*rows, *alias_rows])
    return list(dict.fromkeys(seeds))[:limit]


def search_graph(
    query: str,
    *,
    graph_path: Path,
    seed_ids: Sequence[str] = (),
    max_hops: int = 2,
    limit: int = 10,
) -> list[dict]:
    """Find bounded graph evidence from text, aliases, and hybrid seed IDs."""

    _validate_bounds(max_hops, limit)
    if not query.strip() or not graph_path.is_file():
        return []
    with _connect(graph_path) as connection:
        seeds: list[str] = []
        for identifier in seed_ids[:limit]:
            seeds.extend(_resolve_identifier(connection, identifier, limit))
        seeds.extend(_query_seeds(connection, query, limit))
        seeds = list(dict.fromkeys(seeds))[:limit]
        frontier: list[tuple[str, list[dict[str, Any]]]] = []
        results: list[dict] = []
        seen: set[str] = set()
        for node_id in seeds:
            row = connection.execute(
                "SELECT id, type, label FROM nodes WHERE id = ? LIMIT 1", (node_id,)
            ).fetchone()
            if row is not None:
                frontier.append((str(row["id"]), []))
                seen.add(str(row["id"]))
                results.append({"id": row["id"], "type": row["type"], "label": row["label"], "path": []})
                if len(results) >= limit:
                    return results
        for _ in range(max_hops):
            next_frontier: list[tuple[str, list[dict[str, Any]]]] = []
            for source_id, path in frontier:
                remaining = limit - len(results)
                if remaining <= 0:
                    return results
                for row in _edge_rows(connection, source_id, remaining):
                    edge = _edge_dict(row)
                    evidence = [*path, edge]
                    target_id = edge["target_id"]
                    if target_id in seen:
                        continue
                    seen.add(target_id)
                    results.append(
                        {
                            "id": target_id,
                            "type": edge["target_type"],
                            "label": edge["target_label"],
                            "path": evidence,
                        }
                    )
                    next_frontier.append((target_id, evidence))
            frontier = next_frontier
            if not frontier:
                break
        return results[:limit]


def graph_status(graph_path: Path) -> dict[str, Any]:
    """Read small graph metadata and counts without touching source Markdown."""

    if not graph_path.is_file():
        return {"ready": False, "path": str(graph_path), "nodes": 0, "edges": 0, "fingerprint": None}
    try:
        with _connect(graph_path) as connection:
            fingerprint = connection.execute(
                "SELECT value FROM metadata WHERE key = 'corpus_fingerprint' LIMIT 1"
            ).fetchone()
            ready = connection.execute(
                "SELECT value FROM metadata WHERE key = 'build_ready' LIMIT 1"
            ).fetchone()
            return {
                "ready": bool(fingerprint) and bool(ready) and str(ready[0]).lower() == "true",
                "path": str(graph_path),
                "nodes": _count(connection, "nodes"),
                "edges": _count(connection, "edges"),
                "fingerprint": str(fingerprint[0]) if fingerprint else None,
            }
    except sqlite3.DatabaseError:
        return {"ready": False, "path": str(graph_path), "nodes": 0, "edges": 0, "fingerprint": None}


__all__ = [
    "GraphBuildResult",
    "build_graph",
    "get_relations",
    "graph_status",
    "initialize_graph",
    "search_graph",
]
