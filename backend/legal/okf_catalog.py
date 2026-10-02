"""Write and validate the small OKF v0.2 catalog for the legal indexes.

The catalog intentionally contains metadata and links only. The source
corpora remain in ``data/legal`` and are never read or copied by this module.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml


FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)
_SEPARATOR = re.compile(r"(?m)^---[ \t]*$")


def _frontmatter(
    path: Path, raw: str
) -> tuple[dict[str, Any] | None, re.Match[str] | None, str | None]:
    """Parse the one leading frontmatter block in *raw*."""

    match = FRONTMATTER.match(raw)
    if not match:
        return None, None, f"{path}: missing leading frontmatter"
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return None, match, f"{path}: invalid frontmatter ({exc})"
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        return None, match, f"{path}: frontmatter must be a mapping"
    return metadata, match, None


def _has_duplicate_frontmatter(raw: str, offset: int) -> bool:
    """Detect a later YAML mapping block, while allowing body separators.

    A Markdown thematic break has no matching closing separator, so it is not
    considered frontmatter. A later pair of separators is only considered a
    duplicate when its contents parse as a YAML mapping.
    """

    body = raw[offset:]
    opening = _SEPARATOR.search(body)
    while opening:
        closing = _SEPARATOR.search(body, opening.end())
        if not closing:
            return False
        candidate = body[opening.end() : closing.start()]
        try:
            metadata = yaml.safe_load(candidate)
        except yaml.YAMLError:
            metadata = None
        if isinstance(metadata, dict) and metadata:
            return True
        opening = _SEPARATOR.search(body, closing.end())
    return False


def validate_bundle(root: Path) -> list[str]:
    """Return conformance diagnostics for an OKF bundle.

    An empty list means the bundle has a v0.2 root index and every concept
    document has one leading YAML block with a non-empty ``type`` field.
    """

    root = Path(root)
    errors: list[str] = []
    if not root.exists() or not root.is_dir():
        return [f"{root}: bundle directory does not exist"]

    index_path = root / "index.md"
    if not index_path.is_file():
        errors.append(f"{index_path}: missing bundle index")

    for path in sorted(root.rglob("*.md")):
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"{path}: cannot read ({exc})")
            continue

        metadata, match, parse_error = _frontmatter(path, raw)
        if parse_error:
            errors.append(parse_error)
            continue

        assert metadata is not None and match is not None
        if _has_duplicate_frontmatter(raw, match.end()):
            errors.append(f"{path}: duplicate frontmatter")

        if path == index_path:
            version = metadata.get("okf_version")
            if version != "0.2":
                errors.append(f"{path}: unsupported okf_version (expected 0.2)")
            continue

        if not str(metadata.get("type", "")).strip():
            errors.append(f"{path}: missing non-empty type")

    return errors


_CONCEPTS: dict[str, str] = {
    "index.md": """---
okf_version: "0.2"
title: Korea Legal RAG catalog
---

# Korea Legal RAG

This OKF v0.2 catalog describes the Korean legal source corpora and their
derived retrieval artifacts.

- [Laws](laws.md)
- [Precedents](precedents.md)
- [Lexical index](lexical-index.md)
- [Vector index](vector-index.md)
- [Ontology](ontology.md)
- [Graph index](graph-index.md)
""",
    "laws.md": """---
type: Legal Corpus
title: Legal Corpus — Laws
resource: ../../data/legal/full
language: ko
---

# Legal Corpus: Laws

The source law corpus is available at `../../data/legal/full`. This catalog
references that directory; source Markdown is not copied here.
""",
    "precedents.md": """---
type: Legal Corpus
title: Legal Corpus — Precedents
resource: ../../data/legal/precedent
language: ko
---

# Legal Corpus: Precedents

The source precedent corpus is available at `../../data/legal/precedent`.
This catalog references that directory; source Markdown is not copied here.
""",
    "lexical-index.md": """---
type: Search Index
title: Lexical Search Index
sources:
  - ../../data/legal_fts.sqlite3
  - ../../data/precedent_fts.sqlite3
backend: sqlite-fts
---

# Lexical Search Index

SQLite FTS indexes for bounded lexical lookup over the laws and precedents
corpora.
""",
    "vector-index.md": """---
type: Vector Index
title: Semantic Vector Index
resource: ../../data/qdrant
model: nvidia/nemotron-3-embed-1b
dimension: 2048
build_status: optional
---

# Semantic Vector Index

The local Qdrant store is referenced at `../../data/qdrant`. It is queried
lazily when a compatible completed index is available.
""",
    "ontology.md": """---
type: Ontology
title: Legal Ontology Schema
resource: ../../ontology/legal-wiki.ttl
format: turtle
---

# Legal Ontology

The generated Turtle schema and curated knowledge artifact is referenced at
`../../ontology/legal-wiki.ttl`.
""",
    "graph-index.md": """---
type: Graph Index
title: Legal Relationship Graph
resource: ../../data/legal_graph.sqlite3
backend: sqlite
max_hops: 2
---

# Legal Relationship Graph

The bounded, persistent graph index is referenced at
`../../data/legal_graph.sqlite3`.
""",
}


def write_bundle(root: Path, project_root: Path) -> list[Path]:
    """Generate the seven-file catalog under *root* and return its paths."""

    # Links intentionally stay portable and relative to the catalog rather
    # than embedding the caller's project path.
    del project_root
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, content in _CONCEPTS.items():
        path = root / name
        path.write_text(content, encoding="utf-8", newline="\n")
        written.append(path)
    return written


__all__ = ["FRONTMATTER", "validate_bundle", "write_bundle"]
