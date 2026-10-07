"""Canonical identifiers and conservative citation parsing for legal documents.

This module deliberately has no corpus or application imports.  The functions
operate on one document at a time so builders can stream large collections.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import unicodedata
from typing import Any, Mapping

import yaml


_FRONTMATTER = re.compile(
    r"\A---[ \t]*\r?\n(?P<header>.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)
# A second delimiter is not valid frontmatter.  Keep this intentionally strict:
# a source document can contain Markdown separators, but a second block is
# almost invariably an accidentally concatenated document.
_FRONTMATTER_OPEN = re.compile(r"(?m)^---[ \t]*\r?\n")
_FRONTMATTER_CLOSE = re.compile(r"(?m)^---[ \t]*(?:\r?\n|$)")

_LAW_ID_KEYS = ("법령ID", "법령id", "law_id", "lawId")
_LAW_MST_KEYS = ("법령MST", "법령mst", "law_mst", "lawMst")
_LAW_NAME_KEYS = ("법령명", "제목", "원본제목", "law_name", "title")
_PRECEDENT_ID_KEYS = (
    "판례일련번호",
    "판례일련번호ID",
    "precedent_id",
    "precedentId",
)
_CASE_NUMBER_KEYS = ("사건번호", "사건번호표시", "case_number", "caseNumber")


@dataclass(frozen=True, slots=True)
class LegalCitation:
    """A directly stated law/article citation.

    The dataclass is frozen because citations are passed between indexing
    stages and must not change after they have been used to create an edge.
    """

    law_name: str
    article_number: str


def _nfc(value: Any) -> Any:
    """Normalize strings (including values nested in YAML metadata) to NFC."""

    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, dict):
        return {_nfc(key): _nfc(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_nfc(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_nfc(item) for item in value)
    if isinstance(value, set):
        return {_nfc(item) for item in value}
    return value


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    """Parse exactly one leading YAML frontmatter block and return its body.

    A legal source document without a leading block is malformed for the
    derived indexes, so malformed or concatenated blocks raise ``ValueError``
    with a stable, useful message.
    """

    raw = unicodedata.normalize("NFC", path.read_text(encoding="utf-8"))
    match = _FRONTMATTER.match(raw)
    if match is None:
        raise ValueError(f"{path}: missing or invalid frontmatter")
    if _has_duplicate_frontmatter(raw, match.end()):
        raise ValueError(f"{path}: duplicate frontmatter")

    try:
        loaded = yaml.safe_load(match.group("header"))
    except yaml.YAMLError as exc:
        raise ValueError(f"{path}: invalid frontmatter YAML") from exc
    if loaded is None:
        metadata: dict[str, Any] = {}
    elif isinstance(loaded, dict):
        metadata = _nfc(loaded)
    else:
        raise ValueError(f"{path}: frontmatter must be a mapping")
    return metadata, raw[match.end() :]


def _has_duplicate_frontmatter(raw: str, start: int) -> bool:
    """Recognize a later YAML mapping block, while allowing ``---`` rules.

    A Markdown horizontal rule has no matching YAML mapping between two
    delimiters.  Requiring a mapping here preserves detection of accidentally
    concatenated frontmatter without rejecting ordinary body Markdown.
    """

    for opening in _FRONTMATTER_OPEN.finditer(raw, start):
        closing = _FRONTMATTER_CLOSE.search(raw, opening.end())
        if closing is None:
            continue
        candidate = raw[opening.end() : closing.start()]
        try:
            parsed = yaml.safe_load(candidate)
        except yaml.YAMLError:
            continue
        if isinstance(parsed, dict):
            return True
    return False


def _metadata_value(metadata: Mapping[str, Any], keys: tuple[str, ...]) -> Any:
    wanted = {unicodedata.normalize("NFC", key) for key in keys}
    for key, value in metadata.items():
        if isinstance(key, str) and unicodedata.normalize("NFC", key) in wanted:
            if value is not None and str(value).strip():
                return value
    return None


def _clean_identifier(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = unicodedata.normalize("NFC", str(value)).strip()
    return cleaned or None


def _relative_path(value: str) -> str:
    # IDs must be independent of the host platform's path separator.  Do not
    # resolve the path: callers commonly pass a corpus-relative path.
    return unicodedata.normalize("NFC", str(value)).replace("\\", "/").strip()


def _hashed_id(prefix: str, relative_path: str) -> str:
    digest = hashlib.sha256(_relative_path(relative_path).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}:{digest}"


def law_id(metadata: Mapping[str, Any], relative_path: str) -> str:
    """Return the canonical law identifier, preferring ``법령ID``."""

    official = _clean_identifier(_metadata_value(metadata, _LAW_ID_KEYS))
    return f"law:{official}" if official is not None else _hashed_id("law", relative_path)


def _normalized_article_number(number: str) -> str:
    value = unicodedata.normalize("NFC", str(number)).strip()
    # Accept the forms found in Korean legal prose while returning one stable
    # representation (e.g. ``제 10 조의 2`` -> ``10의2``).
    value = re.sub(r"\s+", "", value)
    # Some historical sources duplicate the trailing article marker
    # (for example ``제12조의2조``). Normalize that harmless typo.
    if value.startswith("제") and value.count("조") >= 2 and value.endswith("조"):
        value = value[:-1]
    match = re.fullmatch(r"제?(\d+(?:의\d+)?)(?:조(?:의(?P<sub>\d+))?)?", value)
    if match is None:
        raise ValueError(f"invalid article number: {number!r}")
    return match.group(1) + (f"의{match.group('sub')}" if match.group("sub") else "")


def article_id(parent_law_id: str, number: str) -> str:
    """Build a stable article identifier beneath a canonical law ID."""

    parent = unicodedata.normalize("NFC", str(parent_law_id)).strip()
    if not parent:
        raise ValueError("parent_law_id must be non-empty")
    return f"{parent}:article:{_normalized_article_number(number)}"


def precedent_id(metadata: Mapping[str, Any], relative_path: str) -> str:
    """Return the canonical precedent identifier, preferring its sequence."""

    official = _clean_identifier(_metadata_value(metadata, _PRECEDENT_ID_KEYS))
    return (
        f"precedent:{official}"
        if official is not None
        else _hashed_id("precedent", relative_path)
    )


def document_aliases(metadata: Mapping[str, Any], path: Path) -> tuple[str, ...]:
    """Return deterministic aliases useful for joining old index results.

    Both the path spelling supplied by the caller and platform-independent
    slash spelling are retained; this lets an existing SQLite index resolve
    identifiers produced on either Windows or POSIX.
    """

    aliases: list[str] = []

    def add(value: Any) -> None:
        cleaned = _clean_identifier(value)
        if cleaned is not None and cleaned not in aliases:
            aliases.append(cleaned)

    add(str(path))
    add(path.as_posix())
    add(path.name)
    add(path.stem)
    # Include the canonical IDs as aliases as well as their unprefixed source
    # identifiers.  This is what allows old FTS IDs and new graph IDs to join.
    law_official = _clean_identifier(_metadata_value(metadata, _LAW_ID_KEYS))
    law_mst = _clean_identifier(_metadata_value(metadata, _LAW_MST_KEYS))
    precedent_official = _clean_identifier(_metadata_value(metadata, _PRECEDENT_ID_KEYS))
    case_number = _clean_identifier(_metadata_value(metadata, _CASE_NUMBER_KEYS))
    law_name = _clean_identifier(_metadata_value(metadata, _LAW_NAME_KEYS))
    for value in (law_official, law_mst, precedent_official, case_number, law_name):
        add(value)
    if law_official is not None:
        add(f"law:{law_official}")
    if precedent_official is not None:
        add(f"precedent:{precedent_official}")
    return tuple(aliases)


# Legal titles are deliberately restricted to common statute suffixes.  This
# avoids treating arbitrary prose immediately before ``제 N조`` as a citation.
_TITLE_SUFFIXES = r"(?:법률|헌법|법|령|규칙|조례|규정)"
_TITLE_RE = re.compile(
    rf"(?P<title>[가-힣A-Za-z0-9][가-힣A-Za-z0-9·ㆍ()\[\]「」『』 ]{{0,79}}?{_TITLE_SUFFIXES})[ \t]*$"
)
_ARTICLE_RE = re.compile(
    r"(?:제[ \t]*)?(?P<number>\d+(?:[ \t]*의[ \t]*\d+)?)[ \t]*조"
    r"(?:[ \t]*의[ \t]*(?P<subnumber>\d+))?"
)
_GENERIC_BARE_LAW_ENDINGS = (
    "방법",
    "사용법",
    "문법",
    "용법",
    "기법",
    "화법",
    "표현법",
    "접근법",
)


def _title_before(text: str, start: int) -> str | None:
    prefix = text[max(0, start - 120) : start]
    # A punctuation boundary prevents a title in an earlier sentence from
    # being paired with an otherwise unrelated article heading.
    prefix = re.split(r"[.!?。！？;；:\n\r]", prefix)[-1]
    match = _TITLE_RE.search(prefix)
    if match is None:
        return None
    title = re.sub(r"\s+", " ", match.group("title")).strip()
    # If two titles occur in a coordinated phrase, keep the title nearest the
    # article (e.g. ``민법 및 개인정보 보호법 제10조``).
    pieces = re.split(r"\s+(?:및|또는)\s+", title)
    title = pieces[-1].strip() if pieces else title
    # A bare ``법`` suffix is common in ordinary prose (``이 방법``).  Keep
    # named statutes and explicit legal-title suffixes, but reject these
    # unambiguous generic nouns to avoid creating false graph edges.
    if title.endswith(_GENERIC_BARE_LAW_ENDINGS):
        return None
    return title


def extract_citations(text: str) -> tuple[LegalCitation, ...]:
    """Extract directly adjacent Korean law/article pairs in source text."""

    normalized = unicodedata.normalize("NFC", text)
    citations: list[LegalCitation] = []
    seen: set[tuple[str, str]] = set()
    for match in _ARTICLE_RE.finditer(normalized):
        title = _title_before(normalized, match.start())
        if not title:
            continue
        number = re.sub(r"\s+", "", match.group("number"))
        if match.group("subnumber"):
            number = f"{number}의{match.group('subnumber')}"
        citation = (title, number)
        if citation not in seen:
            seen.add(citation)
            citations.append(LegalCitation(*citation))
    return tuple(citations)


__all__ = [
    "LegalCitation",
    "article_id",
    "document_aliases",
    "extract_citations",
    "law_id",
    "parse_frontmatter",
    "precedent_id",
]
