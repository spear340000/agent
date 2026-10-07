from pathlib import Path

from okf_catalog import validate_bundle, write_bundle


def test_generated_bundle_is_okf_v02_conformant(tmp_path: Path):
    root = tmp_path / "okf"
    written = write_bundle(root, tmp_path)

    assert {path.name for path in written} >= {
        "index.md",
        "laws.md",
        "precedents.md",
        "lexical-index.md",
        "vector-index.md",
        "ontology.md",
        "graph-index.md",
    }
    assert validate_bundle(root) == []


def test_validator_rejects_missing_type_and_duplicate_frontmatter(tmp_path: Path):
    root = tmp_path / "okf"
    root.mkdir()
    (root / "missing.md").write_text(
        "---\ntitle: Missing\n---\nBody\n", encoding="utf-8"
    )
    (root / "duplicate.md").write_text(
        "---\ntype: Legal Corpus\n---\nBody\n---\ntype: Other\n---\n",
        encoding="utf-8",
    )

    errors = validate_bundle(root)

    assert any("missing.md" in error and "type" in error for error in errors)
    assert any("duplicate.md" in error and "frontmatter" in error for error in errors)


def test_validator_rejects_unsupported_bundle_version(tmp_path: Path):
    root = tmp_path / "okf"
    root.mkdir()
    (root / "index.md").write_text(
        '---\nokf_version: "0.1"\n---\n# Bundle\n', encoding="utf-8"
    )

    errors = validate_bundle(root)

    assert any("index.md" in error and "okf_version" in error for error in errors)


def test_validator_rejects_concept_without_leading_frontmatter(tmp_path: Path):
    root = tmp_path / "okf"
    root.mkdir()
    (root / "index.md").write_text(
        '---\nokf_version: "0.2"\n---\n# Bundle\n', encoding="utf-8"
    )
    (root / "concept.md").write_text("# Concept\n---\ntype: Other\n---\n", encoding="utf-8")

    errors = validate_bundle(root)

    assert any("concept.md" in error and "leading frontmatter" in error for error in errors)


def test_validator_allows_markdown_thematic_break_in_concept_body(tmp_path: Path):
    root = tmp_path / "okf"
    root.mkdir()
    (root / "index.md").write_text(
        '---\nokf_version: "0.2"\n---\n# Bundle\n', encoding="utf-8"
    )
    (root / "concept.md").write_text(
        "---\n"
        "type: Legal Corpus\n"
        "---\n"
        "# Concept\n\n"
        "Before the related notes.\n\n"
        "---\n\n"
        "After the notes.\n",
        encoding="utf-8",
    )

    assert validate_bundle(root) == []
