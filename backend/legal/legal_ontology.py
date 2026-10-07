from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import yaml
from rdflib import RDF, RDFS, Graph, Literal, Namespace, URIRef

LEGAL = Namespace("https://knowledge-rag.local/legal/")
FRONTMATTER_RE = re.compile(r"(?ms)^---\s*\n(.*?)^---\s*$")
ARTICLE_RE = re.compile(
    r"(?m)^(?:#{2,6}\s*)?(?:[-*]\s*)?"
    r"(제\d+조(?:의\d+)?)"
    r"(?:\s*\(([^)\n]+)\)|\s+([^:\n]{1,80})\s*:)"
    r"[ \t]*(.*)$"
)
PENALTY_RE = re.compile(
    r"사형|무기(?:징역|금고)?|"
    r"\d+(?:년|개월)\s*(?:이상(?:의)?(?:\s*\d+(?:년|개월)\s*이하(?:의)?)?|이하(?:의)?)\s*(?:징역|금고)|"
    r"\d+(?:억|천|백)?(?:만)?원\s*이하의\s*벌금"
)


@dataclass(frozen=True)
class WikiDocument:
    path: str
    kind: str
    title: str
    body: str
    sources: tuple[str, ...]
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ArticleRecord:
    law: str
    number: str
    title: str
    text: str
    penalties: tuple[str, ...]
    wiki_path: str
    sources: tuple[str, ...]


def _as_sources(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(str(item) for item in value if item)
    return (str(value),)


def parse_wiki(path: Path) -> WikiDocument:
    raw = path.read_text(encoding="utf-8")
    candidates = []
    for match in FRONTMATTER_RE.finditer(raw):
        try:
            metadata = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError:
            continue
        if isinstance(metadata, dict):
            candidates.append((match, metadata))
    if not candidates:
        metadata, body = {}, raw
    else:
        selected = next(
            (item for item in candidates if str(item[1].get("type", "")).lower() == "law"),
            candidates[0],
        )
        index = candidates.index(selected)
        match, metadata = selected
        end = candidates[index + 1][0].start() if index + 1 < len(candidates) else len(raw)
        body = raw[match.end():end].strip()
    title = str(metadata.get("title") or metadata.get("제목") or path.stem)
    kind = str(metadata.get("type") or metadata.get("법령구분") or "Document")
    sources = _as_sources(metadata.get("sources") or metadata.get("출처"))
    return WikiDocument(str(path), kind, title, body, sources, metadata)


def _clean_text(value: str) -> str:
    value = re.sub(r"(?m)^#{1,6}\s*", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _penalties(text: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(match.group(0).strip() for match in PENALTY_RE.finditer(text)))


def extract_articles(document: WikiDocument) -> list[ArticleRecord]:
    hits = list(ARTICLE_RE.finditer(document.body))
    records = []
    for index, hit in enumerate(hits):
        end = hits[index + 1].start() if index + 1 < len(hits) else len(document.body)
        title = _clean_text(hit.group(2) or hit.group(3) or "")
        first_line = hit.group(4).strip()
        remainder = document.body[hit.end():end]
        text = _clean_text(" ".join(part for part in (first_line, remainder) if part))
        records.append(
            ArticleRecord(
                law=document.title,
                number=hit.group(1),
                title=title,
                text=text,
                penalties=_penalties(text),
                wiki_path=document.path,
                sources=document.sources,
            )
        )
    return records


def _uri(kind: str, value: str) -> URIRef:
    readable = quote(re.sub(r"\s+", "-", value.strip()), safe="-_.~")[:100]
    digest = hashlib.sha1(f"{kind}:{value}".encode("utf-8")).hexdigest()[:10]
    return URIRef(f"{LEGAL}{kind}/{readable}-{digest}")


def _node(nodes: dict[str, dict], uri: URIRef, label: str, kind: str, **data: Any) -> None:
    key = str(uri)
    item = {"id": key, "label": label, "type": kind}
    item.update({name: value for name, value in data.items() if value not in (None, "", [], ())})
    nodes[key] = item


def _edge(edges: list[dict], source: URIRef, target: URIRef, relation: str) -> None:
    edge = {"source": str(source), "target": str(target), "relation": relation}
    if edge not in edges:
        edges.append(edge)


def _declare_schema(graph: Graph) -> None:
    for name in (
        "LegalDocument", "Law", "Article", "Precedent", "Court", "LegalConcept",
        "Offense", "Element", "Instrument", "Penalty", "Source",
    ):
        graph.add((LEGAL[name], RDF.type, RDFS.Class))
        graph.add((LEGAL[name], RDFS.label, Literal(name)))
    for name in ("Law", "Article", "Precedent"):
        graph.add((LEGAL[name], RDFS.subClassOf, LEGAL.LegalDocument))
    relations = {
        "hasArticle": ("Law", "Article"),
        "definesOffense": ("Article", "Offense"),
        "hasElement": ("Offense", "Element"),
        "usesInstrument": ("Offense", "Instrument"),
        "hasPenalty": ("Article", "Penalty"),
        "derivedFrom": ("Law", "Source"),
        "citesLaw": ("LegalDocument", "Law"),
        "citesArticle": ("LegalDocument", "Article"),
        "decidedBy": ("Precedent", "Court"),
        "relatesTo": ("Precedent", "LegalConcept"),
    }
    for relation, (domain, range_) in relations.items():
        graph.add((LEGAL[relation], RDF.type, RDF.Property))
        graph.add((LEGAL[relation], RDFS.domain, LEGAL[domain]))
        graph.add((LEGAL[relation], RDFS.range, LEGAL[range_]))


def ontology_contract() -> dict[str, tuple[str, str]]:
    """Return graph-store relation constraints used for instance validation."""

    legal_documents = "Law|Article|Precedent"
    return {
        "HAS_ARTICLE": ("Law", "Article"),
        "CITES_LAW": (legal_documents, "Law"),
        "CITES_ARTICLE": (legal_documents, "Article"),
        "DECIDED_BY": ("Precedent", "Court"),
        "RELATES_TO": ("Precedent", "LegalConcept"),
        "DERIVED_FROM": (legal_documents, "Source"),
    }


def write_schema(ttl_path: Path) -> None:
    """Serialize the ontology schema without materializing corpus instances."""

    graph = Graph()
    graph.bind("legal", LEGAL)
    graph.bind("rdfs", RDFS)
    _declare_schema(graph)
    ttl_path.parent.mkdir(parents=True, exist_ok=True)
    graph.serialize(destination=str(ttl_path), format="turtle")


def validate_graph_types(
    graph_path: Path,
    contract: dict[str, tuple[str, str]],
    *,
    max_errors: int = 100,
) -> list[str]:
    """Validate persisted edge endpoint types against the ontology contract."""

    if max_errors < 1:
        raise ValueError("max_errors must be positive")
    if not graph_path.is_file():
        return [f"graph database not found: {graph_path}"]
    connection = sqlite3.connect(f"file:{graph_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT e.source_id, e.relation, e.target_id,
                   source.type, target.type
            FROM edges AS e
            JOIN nodes AS source ON source.id = e.source_id
            JOIN nodes AS target ON target.id = e.target_id
            ORDER BY e.relation, e.source_id, e.target_id
            """
        )
        errors: list[str] = []
        for source_id, relation, target_id, source_type, target_type in rows:
            expected = contract.get(str(relation))
            if expected is None:
                errors.append(f"{source_id} {relation} {target_id}: undeclared relation")
            else:
                allowed_sources = set(expected[0].split("|"))
                allowed_targets = set(expected[1].split("|"))
                if source_type not in allowed_sources or target_type not in allowed_targets:
                    errors.append(
                        f"{source_id} {relation} {target_id}: "
                        f"{source_type}->{target_type}, expected {expected[0]}->{expected[1]}"
                    )
            if len(errors) >= max_errors:
                break
        return errors
    finally:
        connection.close()


def build_graph(wiki_dir: Path) -> tuple[Graph, dict]:
    graph = Graph()
    graph.bind("legal", LEGAL)
    graph.bind("rdfs", RDFS)
    _declare_schema(graph)
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    documents = 0
    for path in sorted(wiki_dir.rglob("*.md")):
        document = parse_wiki(path)
        articles = extract_articles(document)
        if document.kind.lower() != "law" and not articles:
            continue
        documents += 1
        law_uri = _uri("law", document.title)
        graph.add((law_uri, RDF.type, LEGAL.Law))
        graph.add((law_uri, RDFS.label, Literal(document.title)))
        _node(nodes, law_uri, document.title, "Law", wiki=document.path)
        source_values = tuple(dict.fromkeys((document.path,) + document.sources))
        for source in source_values:
            source_uri = _uri("source", source)
            graph.add((source_uri, RDF.type, LEGAL.Source))
            graph.add((source_uri, RDFS.label, Literal(source)))
            graph.add((law_uri, LEGAL.derivedFrom, source_uri))
            _node(nodes, source_uri, Path(source).name or source, "Source", value=source)
            _edge(edges, law_uri, source_uri, "derivedFrom")
        for article in articles:
            article_key = f"{article.law}:{article.number}"
            article_uri = _uri("article", article_key)
            article_label = f"{article.number} {article.title}".strip()
            graph.add((article_uri, RDF.type, LEGAL.Article))
            graph.add((article_uri, RDFS.label, Literal(article_label)))
            graph.add((article_uri, LEGAL.articleNumber, Literal(article.number)))
            graph.add((article_uri, LEGAL.text, Literal(article.text)))
            graph.add((law_uri, LEGAL.hasArticle, article_uri))
            _node(nodes, article_uri, article_label, "Article", text=article.text, wiki=article.wiki_path)
            _edge(edges, law_uri, article_uri, "hasArticle")
            if article.penalties:
                offense_uri = _uri("offense", article_key)
                graph.add((offense_uri, RDF.type, LEGAL.Offense))
                graph.add((offense_uri, RDFS.label, Literal(article.title or article.number)))
                graph.add((article_uri, LEGAL.definesOffense, offense_uri))
                _node(nodes, offense_uri, article.title or article.number, "Offense")
                _edge(edges, article_uri, offense_uri, "definesOffense")
                for phrase in ("위험한 물건", "흉기"):
                    if phrase in article.text:
                        instrument_uri = _uri("instrument", phrase)
                        graph.add((instrument_uri, RDF.type, LEGAL.Instrument))
                        graph.add((instrument_uri, RDFS.label, Literal(phrase)))
                        graph.add((offense_uri, LEGAL.usesInstrument, instrument_uri))
                        _node(nodes, instrument_uri, phrase, "Instrument")
                        _edge(edges, offense_uri, instrument_uri, "usesInstrument")
            for penalty in article.penalties:
                penalty_uri = _uri("penalty", penalty)
                graph.add((penalty_uri, RDF.type, LEGAL.Penalty))
                graph.add((penalty_uri, RDFS.label, Literal(penalty)))
                graph.add((article_uri, LEGAL.hasPenalty, penalty_uri))
                _node(nodes, penalty_uri, penalty, "Penalty")
                _edge(edges, article_uri, penalty_uri, "hasPenalty")
    plural = {
        "Law": "laws",
        "Article": "articles",
        "Offense": "offenses",
        "Instrument": "instruments",
        "Penalty": "penalties",
        "Source": "sources",
    }
    counts = {
        key: sum(1 for item in nodes.values() if item["type"] == kind)
        for kind, key in plural.items()
    }
    counts.update(documents=documents, nodes=len(nodes), edges=len(edges))
    return graph, {"nodes": list(nodes.values()), "edges": edges, "stats": counts}


def write_outputs(wiki_dir: Path, ttl_path: Path, json_path: Path) -> dict:
    graph, payload = build_graph(wiki_dir)
    ttl_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    graph.serialize(destination=str(ttl_path), format="turtle")
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload["stats"]


def _wiki_fingerprint(wiki_dir: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    paths = sorted(wiki_dir.rglob("*.md")) if wiki_dir.exists() else []
    for path in paths:
        relative = path.relative_to(wiki_dir).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest(), len(paths)


def ensure_ontology_current(
    wiki_dir: Path = Path("wiki"),
    ttl_path: Path = Path("ontology/legal-wiki.ttl"),
    json_path: Path = Path("ontology/legal-wiki.json"),
    manifest_path: Path = Path("ontology/legal-wiki.manifest.json"),
) -> dict[str, Any]:
    """Rebuild generated ontology only when legal Wiki inputs changed."""
    fingerprint, source_files = _wiki_fingerprint(wiki_dir)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        manifest = {}
    if (
        manifest.get("fingerprint") == fingerprint
        and ttl_path.is_file()
        and json_path.is_file()
    ):
        return {
            "rebuilt": False,
            "fingerprint": fingerprint,
            "source_files": source_files,
            "stats": manifest.get("stats", {}),
        }

    for path in (ttl_path, json_path, manifest_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid4().hex
    temporary_ttl = ttl_path.with_name(f".{ttl_path.name}.{token}.tmp")
    temporary_json = json_path.with_name(f".{json_path.name}.{token}.tmp")
    temporary_manifest = manifest_path.with_name(f".{manifest_path.name}.{token}.tmp")
    temporary_paths = (temporary_ttl, temporary_json, temporary_manifest)
    try:
        stats = write_outputs(wiki_dir, temporary_ttl, temporary_json)
        Graph().parse(temporary_ttl, format="turtle")
        json.loads(temporary_json.read_text(encoding="utf-8"))
        new_manifest = {
            "version": 1,
            "fingerprint": fingerprint,
            "source_files": source_files,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "stats": stats,
        }
        temporary_manifest.write_text(
            json.dumps(new_manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary_ttl.replace(ttl_path)
        temporary_json.replace(json_path)
        temporary_manifest.replace(manifest_path)
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)
    return {
        "rebuilt": True,
        "fingerprint": fingerprint,
        "source_files": source_files,
        "stats": stats,
    }
