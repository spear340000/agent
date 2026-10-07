"""Disk-backed legal corpus retrieval for the stdio MCP server."""

from __future__ import annotations

import os
from pathlib import Path
import re
import sqlite3
from typing import Iterator


DATA_ROOT = Path(os.getenv("LEGAL_DATA_ROOT", "data"))
LEGAL_ROOT = Path(os.getenv("LEGAL_LAWS_ROOT", str(DATA_ROOT / "legal" / "full")))
INDEX_PATH = Path(os.getenv("LEGAL_FTS_PATH", str(DATA_ROOT / "legal_fts.sqlite3")))
ARTICLE_RE = re.compile(r"(?m)^#{2,6}\s*(제\d+조(?:의\d+)?)\s*\(")
QUERY_TOKEN_RE = re.compile(r"[가-힣A-Za-z0-9_]{2,}")


def _articles(text: str) -> list[str]:
    hits = list(ARTICLE_RE.finditer(text))
    if hits:
        return [
            text[hit.start() : hits[index + 1].start() if index + 1 < len(hits) else len(text)]
            for index, hit in enumerate(hits)
        ]
    words = text.split()
    return [" ".join(words[start : start + 500]) for start in range(0, len(words), 450) if words[start : start + 500]]


def _documents(root: Path) -> Iterator[tuple[str, str, str, str]]:
    for path in root.rglob("법률.md"):
        text = path.read_text(encoding="utf-8")
        if len(text) < 1000:
            continue
        text = re.split(r"\n##\s*부칙", text, maxsplit=1)[0]
        source = str(path)
        title = path.parent.name
        for number, article in enumerate(_articles(text)):
            document_id = f"{source}:{number}"
            yield document_id, title, source, f"법률명: {title}\n{article}"


def build_index(root: Path = LEGAL_ROOT, index_path: Path = INDEX_PATH) -> int:
    """Build an FTS5 index incrementally, then atomically replace the live index."""
    index_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = index_path.with_suffix(index_path.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            PRAGMA temp_store=FILE;
            CREATE TABLE documents (
                rowid INTEGER PRIMARY KEY,
                id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                source TEXT NOT NULL,
                text TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE documents_fts USING fts5(
                title, text, content='documents', content_rowid='rowid', tokenize='unicode61'
            );
            CREATE INDEX documents_title_idx ON documents(title);
            """
        )
        count = 0
        batch = []
        for item in _documents(root):
            batch.append(item)
            if len(batch) >= 500:
                connection.executemany(
                    "INSERT INTO documents(id, title, source, text) VALUES (?, ?, ?, ?)", batch
                )
                count += len(batch)
                batch.clear()
        if batch:
            connection.executemany(
                "INSERT INTO documents(id, title, source, text) VALUES (?, ?, ?, ?)", batch
            )
            count += len(batch)
        connection.execute("INSERT INTO documents_fts(documents_fts) VALUES ('rebuild')")
        connection.commit()
    finally:
        connection.close()
    os.replace(temporary, index_path)
    return count


def index_ready(index_path: Path = INDEX_PATH) -> bool:
    return index_path.is_file() and index_path.stat().st_size > 0


def ensure_index(root: Path = LEGAL_ROOT, index_path: Path = INDEX_PATH) -> int:
    if index_ready(index_path):
        return 0
    return build_index(root, index_path)


def _match_query(query: str) -> str:
    tokens = list(dict.fromkeys(QUERY_TOKEN_RE.findall(query.lower())))
    if not tokens:
        raise ValueError("query must contain searchable Korean or alphanumeric terms")
    return " OR ".join('"' + token.replace('"', '""') + '"*' for token in tokens)


def search_index(query: str, limit: int = 5, index_path: Path = INDEX_PATH) -> list[dict]:
    if not index_ready(index_path):
        raise RuntimeError("legal search index is not ready")
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT d.id, d.title, d.source, substr(d.text, 1, 1200), bm25(documents_fts, 8.0, 1.0)
            FROM documents_fts
            JOIN documents AS d ON d.rowid = documents_fts.rowid
            WHERE documents_fts MATCH ?
            ORDER BY bm25(documents_fts, 8.0, 1.0)
            LIMIT ?
            """,
            (_match_query(query), limit),
        ).fetchall()
    finally:
        connection.close()
    return [
        {"id": row[0], "title": row[1], "source": row[2], "text": row[3], "score": -float(row[4]), "backend": "sqlite-fts"}
        for row in rows
    ]


def get_document(document_id: str, index_path: Path = INDEX_PATH) -> dict | None:
    if not index_ready(index_path):
        raise RuntimeError("legal search index is not ready")
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT id, title, source, text FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    return {"id": row[0], "title": row[1], "source": row[2], "text": row[3]}


def find_article(law_name: str, article_number: str, index_path: Path = INDEX_PATH) -> dict | None:
    if not index_ready(index_path):
        raise RuntimeError("legal search index is not ready")
    law_name = law_name.strip()
    article_number = article_number.strip().replace(" ", "")
    if article_number.isdigit():
        article_number = f"제{article_number}조"
    elif re.fullmatch(r"\d+조(?:의\d+)?", article_number):
        article_number = "제" + article_number
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            """
            SELECT id, title, source, text
            FROM documents
            WHERE title = ? AND text LIKE ?
            ORDER BY id
            LIMIT 1
            """,
            (law_name, f"%{article_number}%"),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    return {"id": row[0], "title": row[1], "source": row[2], "article_number": article_number, "text": row[3]}


def index_status(index_path: Path = INDEX_PATH) -> dict:
    if not index_ready(index_path):
        return {"ready": False, "documents": 0, "size_bytes": 0}
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        count = int(connection.execute("SELECT count(*) FROM documents").fetchone()[0])
    finally:
        connection.close()
    return {"ready": True, "documents": count, "size_bytes": index_path.stat().st_size}
