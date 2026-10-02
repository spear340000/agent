from pathlib import Path
import unicodedata

import pytest

from legal_identity import (
    LegalCitation,
    article_id,
    document_aliases,
    extract_citations,
    law_id,
    parse_frontmatter,
    precedent_id,
)


def test_ids_prefer_official_identifiers_and_are_stable():
    assert law_id({"법령ID": "001234"}, "kr/법률/민법.md") == "law:001234"
    assert article_id("law:001234", "제 750조") == "law:001234:article:750"
    assert precedent_id({"판례일련번호": "151017"}, "민사/case.md") == "precedent:151017"
    assert law_id({}, "kr/법률/민법.md") == law_id({}, "kr/법률/민법.md")


def test_ids_use_nfc_and_hash_only_when_official_id_is_absent():
    composed = "민법"
    decomposed = unicodedata.normalize("NFD", composed)
    assert law_id({}, f"kr/{composed}.md") == law_id({}, f"kr/{decomposed}.md")
    assert law_id({"법령ID": "  001234  "}, "x.md") == "law:001234"
    assert precedent_id({"판례일련번호": " 151017 "}, "x.md") == "precedent:151017"
    assert article_id("law:1", " 제 001 조 ") == "law:1:article:001"
    assert article_id("law:1", "제750조의2") == "law:1:article:750의2"


def test_parser_returns_one_frontmatter_and_body(tmp_path: Path):
    path = tmp_path / "law.md"
    path.write_text("---\n법령ID: '001234'\n---\n# 민법\n", encoding="utf-8")
    metadata, body = parse_frontmatter(path)
    assert metadata["법령ID"] == "001234"
    assert body.startswith("# 민법")


def test_parser_rejects_missing_or_duplicate_frontmatter(tmp_path: Path):
    missing = tmp_path / "missing.md"
    missing.write_text("# 법률\n", encoding="utf-8")
    with pytest.raises(ValueError, match="frontmatter"):
        parse_frontmatter(missing)

    duplicate = tmp_path / "duplicate.md"
    duplicate.write_text("---\ntitle: one\n---\nbody\n---\ntitle: two\n---\n", encoding="utf-8")
    with pytest.raises(ValueError, match="frontmatter"):
        parse_frontmatter(duplicate)


def test_parser_accepts_markdown_horizontal_rule_after_frontmatter(tmp_path: Path):
    path = tmp_path / "law.md"
    path.write_text("---\ntitle: Law\n---\nintro\n\n---\n\nbody\n", encoding="utf-8")
    metadata, body = parse_frontmatter(path)
    assert metadata["title"] == "Law"
    assert "---" in body


def test_aliases_include_path_stem_and_present_official_fields(tmp_path: Path):
    path = tmp_path / "민법(법률).md"
    aliases = document_aliases(
        {"법령ID": "001234", "법령MST": "284415", "법령명": "민법"}, path
    )
    assert "민법(법률).md" in aliases
    assert "민법(법률)" in aliases
    assert "001234" in aliases
    assert "284415" in aliases
    assert "민법" in aliases


def test_citations_extract_law_and_article_pairs_conservatively():
    citations = extract_citations("민법 제750조 및 개인정보 보호법 제10조에 따른다.")
    assert [(item.law_name, item.article_number) for item in citations] == [
        ("민법", "750"),
        ("개인정보 보호법", "10"),
    ]
    assert all(isinstance(item, LegalCitation) for item in citations)
    with pytest.raises(Exception):
        citations[0].law_name = "다른 법"


def test_citation_normalizes_subarticle_number():
    assert extract_citations("민법 제750조의 2") == (LegalCitation("민법", "750의2"),)


def test_citations_do_not_pair_unrelated_headings():
    assert extract_citations("민법에 관하여 설명한다. 제750조는 별도 문장이다.") == ()


def test_citations_ignore_ordinary_words_that_end_in_beop():
    assert extract_citations("이 방법 제1조에 따른다.") == ()


def test_citations_keep_common_named_statutes():
    assert extract_citations("민법 제750조 및 형법 제20조에 따른다.") == (
        LegalCitation("민법", "750"),
        LegalCitation("형법", "20"),
    )
