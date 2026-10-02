import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from rdflib import RDF, RDFS, Graph, Namespace

from legal_ontology import (
    ArticleRecord,
    build_graph,
    ensure_ontology_current,
    extract_articles,
    ontology_contract,
    parse_wiki,
    validate_graph_types,
    write_schema,
    write_outputs,
)
from legal_graph import initialize_graph


SAMPLE = """---
type: Document
title: wrapper
sources: [raw.md]
---

# wrapper

---
type: Law
title: 형법
sources:
  - https://www.law.go.kr/법령/형법
status: active
---

# 형법 핵심 조문

제250조(살인) 사람을 살해한 자는 사형, 무기 또는 5년 이상의 징역에 처한다.

- 제260조 폭행: 사람의 신체에 대하여 폭행을 가한 자는 2년 이하의 징역, 500만원 이하의 벌금에 처한다.
"""


def write_sample(tmp_path: Path) -> Path:
    path = tmp_path / "criminal.md"
    path.write_text(SAMPLE, encoding="utf-8")
    return path


def test_schema_declares_graph_classes_and_relations(tmp_path):
    """Dropping precedent/court citation terms makes the persisted graph unverifiable."""

    path = tmp_path / "legal-schema.ttl"
    write_schema(path)
    graph = Graph().parse(path, format="turtle")
    legal = Namespace("https://knowledge-rag.local/legal/")

    assert (legal.Precedent, RDF.type, RDFS.Class) in graph
    assert (legal.Court, RDF.type, RDFS.Class) in graph
    assert (legal.LegalConcept, RDF.type, RDFS.Class) in graph
    assert (legal.citesArticle, RDFS.range, legal.Article) in graph
    assert ontology_contract()["DECIDED_BY"] == ("Precedent", "Court")


def test_graph_type_validator_reports_domain_violation(tmp_path):
    """A court cannot be accepted as the citing legal document for an article."""

    graph_path = tmp_path / "graph.sqlite3"
    initialize_graph(graph_path)
    with sqlite3.connect(graph_path) as connection:
        connection.execute(
            "INSERT INTO nodes(id, type, label) VALUES ('court:1', 'Court', '법원')"
        )
        connection.execute(
            "INSERT INTO nodes(id, type, label) VALUES ('article:1', 'Article', '민법 제750조')"
        )
        connection.execute(
            "INSERT INTO edges(source_id, relation, target_id) "
            "VALUES ('court:1', 'CITES_ARTICLE', 'article:1')"
        )

    errors = validate_graph_types(graph_path, ontology_contract())
    assert any("CITES_ARTICLE" in error and "Court" in error for error in errors)


def test_parse_wiki_prefers_embedded_law_frontmatter(tmp_path):
    document = parse_wiki(write_sample(tmp_path))

    assert document.title == "형법"
    assert document.kind == "Law"
    assert document.sources == ("https://www.law.go.kr/법령/형법",)
    assert "제250조" in document.body


def test_extract_articles_and_penalties(tmp_path):
    records = extract_articles(parse_wiki(write_sample(tmp_path)))

    assert records[0] == ArticleRecord(
        law="형법",
        number="제250조",
        title="살인",
        text="사람을 살해한 자는 사형, 무기 또는 5년 이상의 징역에 처한다.",
        penalties=("사형", "무기", "5년 이상의 징역"),
        wiki_path=str(write_sample(tmp_path)),
        sources=("https://www.law.go.kr/법령/형법",),
    )
    assert records[1].number == "제260조"
    assert "500만원 이하의 벌금" in records[1].penalties


def test_build_graph_preserves_types_relations_and_provenance(tmp_path):
    write_sample(tmp_path)
    graph, payload = build_graph(tmp_path)
    legal = Namespace("https://knowledge-rag.local/legal/")

    assert (None, RDF.type, legal.Law) in graph
    assert (None, RDF.type, legal.Article) in graph
    assert (None, RDF.type, legal.Penalty) in graph
    assert (None, legal.hasArticle, None) in graph
    assert (None, legal.hasPenalty, None) in graph
    assert (None, legal.derivedFrom, None) in graph
    assert payload["stats"]["laws"] == 1
    assert payload["stats"]["articles"] == 2
    assert payload["stats"]["penalties"] == 5


def test_write_outputs_creates_valid_turtle_and_json(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    write_sample(wiki)
    ttl = tmp_path / "ontology.ttl"
    data = tmp_path / "ontology.json"

    stats = write_outputs(wiki, ttl, data)

    parsed = Graph().parse(ttl, format="turtle")
    payload = json.loads(data.read_text(encoding="utf-8"))
    assert len(parsed) > 0
    assert stats["articles"] == 2
    assert payload["nodes"]
    assert payload["edges"]


def test_build_command_writes_requested_outputs(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    write_sample(wiki)
    ttl = tmp_path / "legal.ttl"
    data = tmp_path / "legal.json"

    result = subprocess.run(
        [
            sys.executable,
            "build_ontology.py",
            "--wiki",
            str(wiki),
            "--ttl",
            str(ttl),
            "--json",
            str(data),
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert ttl.exists()
    assert data.exists()
    assert "articles=2" in result.stdout


def test_viewer_loads_generated_ontology():
    html = Path("ontology.html").read_text(encoding="utf-8")

    assert "ontology/legal-wiki.json" in html
    assert 'id="graph"' in html
    assert 'id="filters"' in html
    assert 'id="details"' in html


def test_ontology_is_built_once_and_skipped_while_wiki_is_unchanged(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    write_sample(wiki)
    ttl = tmp_path / "ontology" / "legal.ttl"
    data = tmp_path / "ontology" / "legal.json"
    manifest = tmp_path / "ontology" / "manifest.json"

    first = ensure_ontology_current(wiki, ttl, data, manifest)
    ttl_mtime = ttl.stat().st_mtime_ns
    second = ensure_ontology_current(wiki, ttl, data, manifest)

    assert first["rebuilt"] is True
    assert second["rebuilt"] is False
    assert ttl.stat().st_mtime_ns == ttl_mtime
    assert json.loads(manifest.read_text(encoding="utf-8"))["fingerprint"]


def test_ontology_is_rebuilt_after_wiki_changes(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    source = write_sample(wiki)
    ttl = tmp_path / "ontology" / "legal.ttl"
    data = tmp_path / "ontology" / "legal.json"
    manifest = tmp_path / "ontology" / "manifest.json"
    ensure_ontology_current(wiki, ttl, data, manifest)
    old_fingerprint = json.loads(manifest.read_text(encoding="utf-8"))["fingerprint"]

    source.write_text(SAMPLE + "\nchanged", encoding="utf-8")
    result = ensure_ontology_current(wiki, ttl, data, manifest)
    payload = json.loads(data.read_text(encoding="utf-8"))

    assert result["rebuilt"] is True
    assert result["fingerprint"] != old_fingerprint
    assert any("changed" in node.get("text", "") for node in payload["nodes"])


def test_ontology_is_rebuilt_after_wiki_file_is_deleted(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    source = write_sample(wiki)
    ttl = tmp_path / "ontology" / "legal.ttl"
    data = tmp_path / "ontology" / "legal.json"
    manifest = tmp_path / "ontology" / "manifest.json"
    ensure_ontology_current(wiki, ttl, data, manifest)

    source.unlink()
    result = ensure_ontology_current(wiki, ttl, data, manifest)
    payload = json.loads(data.read_text(encoding="utf-8"))

    assert result["rebuilt"] is True
    assert payload["stats"]["documents"] == 0


def test_failed_automatic_rebuild_preserves_previous_outputs(tmp_path, monkeypatch):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    source = write_sample(wiki)
    ttl = tmp_path / "ontology" / "legal.ttl"
    data = tmp_path / "ontology" / "legal.json"
    manifest = tmp_path / "ontology" / "manifest.json"
    ensure_ontology_current(wiki, ttl, data, manifest)
    old_ttl = ttl.read_bytes()
    old_data = data.read_bytes()
    old_manifest = manifest.read_bytes()
    source.write_text(SAMPLE + "\nchanged", encoding="utf-8")

    def fail_build(*_args, **_kwargs):
        raise RuntimeError("build failed")

    monkeypatch.setattr("legal_ontology.write_outputs", fail_build)

    try:
        ensure_ontology_current(wiki, ttl, data, manifest)
    except RuntimeError as exc:
        assert str(exc) == "build failed"
    else:
        raise AssertionError("automatic rebuild failure was swallowed")

    assert ttl.read_bytes() == old_ttl
    assert data.read_bytes() == old_data
    assert manifest.read_bytes() == old_manifest
