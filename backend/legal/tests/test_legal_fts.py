import legal_fts
from legal_fts import build_index, get_document, search_index


def test_disk_index_build_search_and_document_lookup(tmp_path):
    root = tmp_path / "full"
    law_dir = root / "kr" / "테스트법"
    law_dir.mkdir(parents=True)
    article = "## 제1조 (목적)\n직무유기와 위법성 조각 사유를 규정한다.\n"
    (law_dir / "법률.md").write_text(article + ("본문 " * 500), encoding="utf-8")
    index_path = tmp_path / "legal.sqlite3"

    assert build_index(root, index_path) == 1
    results = search_index("직무유기 위법성", 5, index_path)

    assert results[0]["title"] == "테스트법"
    assert results[0]["backend"] == "sqlite-fts"
    document = get_document(results[0]["id"], index_path)
    assert document is not None
    assert "직무유기" in document["text"]

    assert hasattr(legal_fts, "find_article"), "exact law article lookup is not implemented"
    article_result = legal_fts.find_article("테스트법", "제1조", index_path)
    assert article_result is not None
    assert article_result["title"] == "테스트법"
    assert "제1조" in article_result["text"]
