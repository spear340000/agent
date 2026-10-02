import importlib


def test_precedent_disk_index_returns_matching_context(tmp_path):
    try:
        precedent_fts = importlib.import_module("precedent_fts")
    except ModuleNotFoundError:
        assert False, "precedent_fts disk index is not implemented"

    root = tmp_path / "precedent"
    root.mkdir()
    (root / "대법원_2024도100.md").write_text(
        "---\n판례일련번호: '216695'\n사건번호: 2024도100\n---\n\n"
        "# 판결\n\n피고인의 직무유기와 위법성 조각 사유를 판단한다.", encoding="utf-8"
    )
    (root / "대법원_2023다200.md").write_text(
        "# 판결\n\n매매계약의 해제와 원상회복에 관한 사건이다.", encoding="utf-8"
    )
    index_path = tmp_path / "precedents.sqlite3"

    assert precedent_fts.build_index(root, index_path) == 2
    results = precedent_fts.search_index("직무유기 위법성", 5, index_path)

    assert results[0]["case_name"] == "대법원_2024도100"
    assert "직무유기" in results[0]["excerpt"]
    assert results[0]["backend"] == "sqlite-fts"

    matches = precedent_fts.find_case_number("2024도100", 5, index_path)
    assert matches[0]["case_name"] == "대법원_2024도100"

    document = precedent_fts.get_document(matches[0]["id"], 0, 100, index_path)
    assert document is not None
    assert "직무유기" in document["text"]
    assert document["total_length"] > 0

    by_serial = precedent_fts.get_document("216695", 0, 100, index_path)
    by_case_number = precedent_fts.get_document("2024도100", 0, 100, index_path)
    assert by_serial is not None
    assert by_case_number is not None
    assert by_serial["id"] == document["id"]
    assert by_case_number["id"] == document["id"]
