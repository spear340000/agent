"""Low-memory, disk-backed full-text retrieval for Korean precedents."""

from __future__ import annotations

import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
import re
import sqlite3


DATA_ROOT = Path(os.getenv("LEGAL_DATA_ROOT", "data"))
PRECEDENT_ROOT = Path(os.getenv("LEGAL_PRECEDENTS_ROOT", str(DATA_ROOT / "legal" / "precedent")))
INDEX_PATH = Path(os.getenv("LEGAL_PRECEDENT_FTS_PATH", str(DATA_ROOT / "precedent_fts.sqlite3")))
QUERY_TOKEN_RE = re.compile(r"[가-힣A-Za-z0-9_]{2,}")


def _match_query(query: str) -> str:
    tokens = list(dict.fromkeys(QUERY_TOKEN_RE.findall(query.lower())))
    if not tokens:
        raise ValueError("query must contain searchable Korean or alphanumeric terms")
    return " OR ".join('"' + token.replace('"', '""') + '"*' for token in tokens)


def _paths(root: Path):
    for directory, _, filenames in os.walk(root):
        for filename in filenames:
            if filename.endswith(".md"):
                yield Path(directory) / filename


def _read(path: Path) -> tuple[str, str, str] | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return None
    return path.stem, str(path), text


def _resolve_indexed_path(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute() or candidate.is_file():
        return candidate
    if candidate.parts and candidate.parts[0].lower() == "data":
        candidate = Path(*candidate.parts[1:])
    return DATA_ROOT / candidate


def _excerpt(path: str, query: str, max_chars: int = 1200) -> str:
    text = _resolve_indexed_path(path).read_text(encoding="utf-8", errors="replace")
    lowered = text.lower()
    positions = [lowered.find(token) for token in QUERY_TOKEN_RE.findall(query.lower())]
    positions = [position for position in positions if position >= 0]
    start = max(0, (min(positions) if positions else 0) - 250)
    return text[start : start + max_chars].strip()


def build_index(root: Path = PRECEDENT_ROOT, index_path: Path = INDEX_PATH) -> int:
    """Build beside the live database and replace it only after completion."""
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
            PRAGMA cache_size=-32768;
            CREATE TABLE documents (
                rowid INTEGER PRIMARY KEY,
                id TEXT NOT NULL UNIQUE,
                case_name TEXT NOT NULL,
                path TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE documents_fts USING fts5(
                case_name, text, content='', tokenize='unicode61'
            );
            CREATE INDEX documents_case_name_idx ON documents(case_name);
            """
        )
        count = 0
        metadata_batch = []
        fts_batch = []
        path_iterator = iter(_paths(root))
        with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4)) as executor:
            pending = set()
            for _ in range(64):
                try:
                    pending.add(executor.submit(_read, next(path_iterator)))
                except StopIteration:
                    break
            while pending:
                completed, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    item = future.result()
                    if item is not None:
                        case_name, path_text, text = item
                        count += 1
                        metadata_batch.append((count, path_text, case_name, path_text))
                        fts_batch.append((count, case_name, text))
                    try:
                        pending.add(executor.submit(_read, next(path_iterator)))
                    except StopIteration:
                        pass
                if len(metadata_batch) >= 250:
                    connection.executemany(
                        "INSERT INTO documents(rowid, id, case_name, path) VALUES (?, ?, ?, ?)", metadata_batch
                    )
                    connection.executemany(
                        "INSERT INTO documents_fts(rowid, case_name, text) VALUES (?, ?, ?)", fts_batch
                    )
                    metadata_batch.clear()
                    fts_batch.clear()
        if metadata_batch:
            connection.executemany(
                "INSERT INTO documents(rowid, id, case_name, path) VALUES (?, ?, ?, ?)", metadata_batch
            )
            connection.executemany(
                "INSERT INTO documents_fts(rowid, case_name, text) VALUES (?, ?, ?)", fts_batch
            )
        connection.commit()
    finally:
        connection.close()
    os.replace(temporary, index_path)
    return count


def index_ready(index_path: Path = INDEX_PATH) -> bool:
    return index_path.is_file() and index_path.stat().st_size > 0


def search_index(query: str, limit: int = 5, index_path: Path = INDEX_PATH) -> list[dict]:
    if not index_ready(index_path):
        raise RuntimeError("precedent search index is not ready")
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT d.id, d.case_name, d.path, bm25(documents_fts, 5.0, 1.0)
            FROM documents_fts
            JOIN documents AS d ON d.rowid = documents_fts.rowid
            WHERE documents_fts MATCH ?
            ORDER BY bm25(documents_fts, 5.0, 1.0)
            LIMIT ?
            """,
            (_match_query(query), limit),
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "id": row[0],
            "case_name": row[1],
            "path": row[2],
            "excerpt": _excerpt(row[2], query),
            "score": -float(row[3]),
            "backend": "sqlite-fts",
        }
        for row in rows
    ]


def find_case_number(case_number: str, limit: int = 5, index_path: Path = INDEX_PATH) -> list[dict]:
    if not index_ready(index_path):
        raise RuntimeError("precedent search index is not ready")
    normalized = re.sub(r"\s+", "", case_number)
    if not normalized:
        raise ValueError("case_number must be non-empty")
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT id, case_name, path
            FROM documents
            WHERE replace(case_name, ' ', '') LIKE ?
            ORDER BY case_name
            LIMIT ?
            """,
            (f"%{normalized}%", limit),
        ).fetchall()
    finally:
        connection.close()
    return [{"id": row[0], "case_name": row[1], "path": row[2]} for row in rows]


def _frontmatter_value(text: str, key: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*['\"]?([^'\"\r\n]+)", text)
    return match.group(1).strip() if match else None


def _resolve_document(identifier: str, connection: sqlite3.Connection) -> tuple | None:
    exact = connection.execute(
        "SELECT id, case_name, path FROM documents WHERE id = ?", (identifier,)
    ).fetchone()
    if exact is not None:
        return exact

    normalized = re.sub(r"\s+", "", identifier)
    case_rows = connection.execute(
        """
        SELECT id, case_name, path FROM documents
        WHERE replace(case_name, ' ', '') LIKE ?
        ORDER BY case_name LIMIT 20
        """,
        (f"%{normalized}%",),
    ).fetchall()
    for row in case_rows:
        text = _resolve_indexed_path(row[2]).read_text(encoding="utf-8", errors="replace")
        if normalized in re.sub(r"\s+", "", row[1]) or _frontmatter_value(text, "사건번호") == identifier.strip():
            return row

    candidates = connection.execute(
        """
        SELECT d.id, d.case_name, d.path
        FROM documents_fts
        JOIN documents AS d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
        LIMIT 50
        """,
        (_match_query(identifier),),
    ).fetchall()
    for row in candidates:
        text = _resolve_indexed_path(row[2]).read_text(encoding="utf-8", errors="replace")
        if identifier.strip() in {
            _frontmatter_value(text, "판례일련번호"),
            _frontmatter_value(text, "사건번호"),
        }:
            return row
    return None


def get_document(document_id: str, offset: int = 0, max_chars: int = 12000, index_path: Path = INDEX_PATH) -> dict | None:
    if not index_ready(index_path):
        raise RuntimeError("precedent search index is not ready")
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        row = _resolve_document(document_id.strip(), connection)
    finally:
        connection.close()
    if row is None:
        return None
    text = _resolve_indexed_path(row[2]).read_text(encoding="utf-8", errors="replace")
    return {
        "id": row[0],
        "requested_identifier": document_id,
        "case_name": row[1],
        "path": row[2],
        "offset": offset,
        "total_length": len(text),
        "has_more": offset + max_chars < len(text),
        "text": text[offset : offset + max_chars],
    }


def index_status(index_path: Path = INDEX_PATH) -> dict:
    if not index_ready(index_path):
        return {"ready": False, "documents": 0, "size_bytes": 0}
    connection = sqlite3.connect(f"file:{index_path.as_posix()}?mode=ro", uri=True)
    try:
        count = int(connection.execute("SELECT count(*) FROM documents").fetchone()[0])
    finally:
        connection.close()
    return {"ready": True, "documents": count, "size_bytes": index_path.stat().st_size}
