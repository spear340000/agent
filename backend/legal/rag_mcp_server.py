"""Local stdio MCP server exposing retrieval-only access to the legal RAG."""

import json
import os
from pathlib import Path
import sys
import threading
from typing import Any


SERVER_LOG = Path("data/korea-legal-rag.log")


SERVER_INFO = {"name": "korea-legal-rag", "version": "0.2.1"}

TOOLS = [
    {
        "name": "search_all",
        "description": "한국 법령과 판례를 키워드·벡터·관계 그래프로 통합 검색합니다. 한국어 법률 용어로 질의하세요.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "한글 법률 쟁점 또는 검색어"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_laws",
        "description": "한국 법령과 개별 조문을 하이브리드 검색합니다. 한국어 법률 용어로 질의하세요.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "한글 법률명·조문·쟁점"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_law_article",
        "description": "법률명과 조문 번호를 알고 있을 때 해당 조문을 정확히 조회합니다. 예: 법률명 '민법', 조문 '제398조'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "law_name": {"type": "string", "description": "정확한 한글 법률명"},
                "article_number": {"type": "string", "description": "조문 번호. 예: 제398조 또는 398"},
            },
            "required": ["law_name", "article_number"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_precedents",
        "description": "한국 판례의 판시사항과 판결요지를 하이브리드 검색합니다. 한국어 법률 용어로 질의하세요.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "한글 판례 쟁점"}, "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5}}, "required": ["query"], "additionalProperties": False},
    },
    {
        "name": "get_precedent",
        "description": "판례 원문을 조회합니다. 검색 결과의 파일 경로 id, 판례일련번호 또는 사건번호를 사용할 수 있습니다. 긴 판례는 offset을 증가시켜 나누어 읽으세요.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "파일 경로 id, 판례일련번호 또는 사건번호"}, "offset": {"type": "integer", "minimum": 0, "default": 0}, "max_chars": {"type": "integer", "minimum": 1000, "maximum": 30000, "default": 12000}}, "required": ["id"], "additionalProperties": False},
    },
    {
        "name": "find_case_number",
        "description": "사건번호를 알고 있을 때 판례를 직접 찾습니다. 예: 2020다227455.",
        "inputSchema": {"type": "object", "properties": {"case_number": {"type": "string", "description": "한글 사건번호"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5}}, "required": ["case_number"], "additionalProperties": False},
    },
    {
        "name": "get_database_status",
        "description": "법령·판례 인덱스의 준비 여부, 문서 수와 디스크 크기를 확인합니다. 검색 실패 진단에만 사용하세요.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "search_legal_graph",
        "description": "법령·조문·판례 사이의 명시적 관계와 근거 경로를 검색합니다. 한국어 법률 용어로 질의하세요.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "한국어 법률 쟁점"}, "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5}}, "required": ["query"], "additionalProperties": False},
    },
    {
        "name": "get_legal_relations",
        "description": "법령·조문·판례 ID 또는 사건번호에 연결된 관계를 조회합니다. 한국어 법률 식별자를 사용하세요.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "max_hops": {"type": "integer", "minimum": 1, "maximum": 2, "default": 1}, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}, "required": ["id"], "additionalProperties": False},
    },
    {
        "name": "get_knowledge_status",
        "description": "키워드·벡터·그래프·온톨로지·OKF 계층의 실제 준비 상태를 각각 확인합니다.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "search_legal_knowledge",
        "description": "호환용 구형 법령 검색 도구입니다. 새 호출은 search_laws 또는 search_all을 사용하세요. 한글 질의만 사용합니다.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5}}, "required": ["query"], "additionalProperties": False},
    },
    {
        "name": "get_document",
        "description": "호환용 구형 법령 문서 조회 도구입니다. search_legal_knowledge가 반환한 id를 받습니다.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False},
    },
]

# Keep the client-facing metadata readable even when this file is opened in a
# legacy Windows code page.  The protocol itself is UTF-8 and these values are
# what MCP clients display in their tool picker.
_KOREAN_TOOL_DESCRIPTIONS = {
    "search_all": "한국어 법률 용어로 질의하여 법령·판례를 통합 검색합니다.",
    "search_laws": "한국어 법률 용어로 법령과 조문을 검색합니다.",
    "get_law_article": "법령명과 조문 번호로 조문 원문을 조회합니다.",
    "search_precedents": "한국어 법률 용어로 판례를 검색합니다.",
    "get_precedent": "검색 결과의 id, 판례일련번호 또는 사건번호로 판례 원문을 조회합니다.",
    "find_case_number": "사건번호로 판례를 직접 찾습니다.",
    "get_database_status": "법령·판례 인덱스와 지식 계층의 준비 상태를 확인합니다.",
    "search_legal_graph": "한국어 법률 용어로 법령·조문·판례 간 관계를 그래프 검색합니다.",
    "get_legal_relations": "문서 id 또는 사건번호의 연결 관계를 조회합니다.",
    "get_knowledge_status": "벡터·그래프·온톨로지·OKF를 포함한 전체 준비 상태를 확인합니다.",
    "search_legal_knowledge": "한국어로 질의하세요. 하이브리드 법률 RAG 검색을 수행합니다.",
    "get_document": "검색 결과의 id로 법령 문서 원문을 조회합니다.",
}
for _tool in TOOLS:
    _tool["description"] = _KOREAN_TOOL_DESCRIPTIONS.get(_tool["name"], _tool["description"])

_KNOWLEDGE_LOADED = False
_KNOWLEDGE_LOADING = False
_KNOWLEDGE_ERROR: str | None = None
_KNOWLEDGE_LOCK = threading.Lock()
_KNOWLEDGE_READY = threading.Event()


def load_knowledge() -> None:
    """Verify prebuilt indexes; never mutate or rebuild the legal corpus."""
    from legal_fts import index_ready as laws_ready
    from precedent_fts import index_ready as precedents_ready

    missing = []
    if not laws_ready():
        missing.append("law FTS index")
    if not precedents_ready():
        missing.append("precedent FTS index")
    if missing:
        raise RuntimeError("read-only legal indexes are missing: " + ", ".join(missing))


def _load_in_background() -> None:
    global _KNOWLEDGE_LOADED, _KNOWLEDGE_LOADING, _KNOWLEDGE_ERROR
    try:
        load_knowledge()
        _KNOWLEDGE_LOADED = True
    except Exception as exc:
        _KNOWLEDGE_ERROR = str(exc)
    finally:
        _KNOWLEDGE_LOADING = False
        _KNOWLEDGE_READY.set()


def _start_knowledge_load() -> None:
    global _KNOWLEDGE_LOADING
    with _KNOWLEDGE_LOCK:
        if _KNOWLEDGE_LOADED or _KNOWLEDGE_LOADING:
            return
        _KNOWLEDGE_LOADING = True
        threading.Thread(target=_load_in_background, name="legal-rag-loader", daemon=True).start()


def _loading_response() -> dict[str, Any] | None:
    _start_knowledge_load()
    # MCP clients may close a tool connection after only a few seconds.
    # Never block the protocol while the corpus is loading.
    _KNOWLEDGE_READY.wait(timeout=0.05)
    if _KNOWLEDGE_LOADED:
        return None
    if _KNOWLEDGE_ERROR:
        raise RuntimeError(f"knowledge base loading failed: {_KNOWLEDGE_ERROR}")
    return {
        "status": "indexing",
        "message": "The legal knowledge base is loading in the background. Retry this search shortly.",
        "results": [],
    }


def _source_for(document_id: str) -> str:
    return document_id.rsplit(":", 1)[0] if ":" in document_id else document_id


def _vector_config():
    from legal_vector import DEFAULT_DIMENSION, DEFAULT_MODEL, VectorStoreConfig

    return VectorStoreConfig(
        path=Path(os.getenv("QDRANT_PATH", "data/qdrant")),
        collection=os.getenv("QDRANT_COLLECTION", "legal_vectors"),
        model=os.getenv("NVIDIA_EMBED_MODEL", DEFAULT_MODEL),
        dimension=int(os.getenv("NVIDIA_EMBED_DIM", str(DEFAULT_DIMENSION))),
    )


def create_retriever():
    """Create lightweight callables; every backend opens resources per operation."""
    from hybrid_retrieval import HybridRetriever, RetrievalBackendUnavailable

    def lexical(query: str, corpus: str, limit: int) -> list[dict[str, Any]]:
        hits: list[dict[str, Any]] = []
        if corpus in {"law", "all"}:
            from legal_fts import search_index as search_law_index

            for item in search_law_index(query, limit=limit):
                hits.append(
                    {
                        **item,
                        "excerpt": item.get("text", "")[:1200],
                        "corpus": "law",
                    }
                )
        if corpus in {"precedent", "all"}:
            from precedent_fts import search_index as search_precedent_index

            for item in search_precedent_index(query, limit=limit):
                hits.append(
                    {
                        **item,
                        "title": item.get("case_name", ""),
                        "source": item.get("path", ""),
                        "corpus": "precedent",
                    }
                )
        return hits

    def vector(query: str, corpus: str, limit: int) -> list[dict[str, Any]]:
        if os.getenv("USE_QDRANT", "false").lower() != "true":
            raise RetrievalBackendUnavailable("vector retrieval is disabled")
        from legal_embeddings import EmbeddingConfig, NvidiaEmbedder
        from legal_vector import search_vectors

        config = _vector_config()
        embedder = NvidiaEmbedder(
            EmbeddingConfig(model=config.model, dimension=config.dimension)
        )
        if os.getenv("QDRANT_BACKEND", "memmap").lower() == "memmap":
            if corpus == "precedent":
                raise RetrievalBackendUnavailable("memory-bounded legacy vector index contains law points only")
            from legacy_vector_index import search as search_memmap

            embedded = embedder.embed([query], "query")
            return search_memmap(embedded[0], limit=limit)
        return search_vectors(
            query,
            embedder=embedder,
            config=config,
            corpus=None if corpus == "all" else corpus,
            limit=limit,
        )

    def graph(query: str, seed_ids: list[str], limit: int) -> list[dict[str, Any]]:
        from legal_graph import graph_status, search_graph

        graph_path = Path(os.getenv("LEGAL_GRAPH_PATH", "data/legal_graph.sqlite3"))
        status = graph_status(graph_path)
        if not status["ready"]:
            raise RetrievalBackendUnavailable("legal graph is not ready")
        return search_graph(
            query,
            graph_path=graph_path,
            seed_ids=seed_ids,
            max_hops=2,
            limit=limit,
        )

    return HybridRetriever(lexical=lexical, vector=vector, graph=graph)


def _hybrid_search(query: str, corpus: str, limit: int) -> dict[str, Any]:
    result = create_retriever().search(query, corpus=corpus, limit=limit)
    results = result.results
    if corpus == "precedent":
        results = [
            {**item, "case_name": item.get("title", ""), "path": item.get("source", "")}
            for item in results
        ]
    return {
        "query": result.query,
        "corpus": result.corpus,
        "mode": "hybrid-rag",
        "backends": result.backends,
        "results": results,
    }


def search_legal_knowledge(query: str, limit: int = 5) -> dict[str, Any]:
    """Retrieve hybrid law hits without invoking the chat model."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ValueError("limit must be an integer between 1 and 20")

    return _hybrid_search(query.strip(), "law", limit)


def get_document(document_id: str) -> dict[str, Any]:
    if not isinstance(document_id, str) or not document_id.strip():
        raise ValueError("id must be a non-empty string")
    loading = _loading_response()
    if loading:
        loading["id"] = document_id
        return loading
    from legal_fts import get_document as get_indexed_document

    document = get_indexed_document(document_id)
    if document is None:
        raise ValueError(f"document not found: {document_id}")
    return document


def search_precedents(query: str, limit: int = 5) -> dict[str, Any]:
    """Hybrid-search precedents without scanning the corpus at startup."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
        raise ValueError("limit must be an integer between 1 and 10")
    return _hybrid_search(query.strip(), "precedent", limit)


def search_all(query: str, limit: int = 5) -> dict[str, Any]:
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
        raise ValueError("limit must be an integer between 1 and 10")
    return _hybrid_search(query.strip(), "all", limit)


def get_law_article(law_name: str, article_number: str) -> dict[str, Any]:
    if not isinstance(law_name, str) or not law_name.strip():
        raise ValueError("law_name must be a non-empty string")
    if not isinstance(article_number, str) or not article_number.strip():
        raise ValueError("article_number must be a non-empty string")
    from legal_fts import find_article

    document = find_article(law_name, article_number)
    if document is None:
        raise ValueError(f"law article not found: {law_name} {article_number}")
    return document


def get_precedent(document_id: str, offset: int = 0, max_chars: int = 12000) -> dict[str, Any]:
    if not isinstance(document_id, str) or not document_id.strip():
        raise ValueError("id must be a non-empty string")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or not 1000 <= max_chars <= 30000:
        raise ValueError("max_chars must be an integer between 1000 and 30000")
    from precedent_fts import get_document as get_precedent_document

    document = get_precedent_document(document_id, offset=offset, max_chars=max_chars)
    if document is None:
        raise ValueError(f"precedent not found: {document_id}")
    return document


def find_case_number(case_number: str, limit: int = 5) -> dict[str, Any]:
    if not isinstance(case_number, str) or not case_number.strip():
        raise ValueError("case_number must be a non-empty string")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ValueError("limit must be an integer between 1 and 20")
    from precedent_fts import find_case_number as find_indexed_case_number

    return {"query": case_number, "results": find_indexed_case_number(case_number, limit=limit)}


def search_legal_graph(query: str, limit: int = 5) -> dict[str, Any]:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
        raise ValueError("limit must be an integer between 1 and 10")
    from legal_graph import graph_status, search_graph

    graph_path = Path(os.getenv("LEGAL_GRAPH_PATH", "data/legal_graph.sqlite3"))
    status = graph_status(graph_path)
    if not status["ready"]:
        raise RuntimeError("legal graph is not ready; run build_legal_graph.py")
    return {
        "query": query,
        "results": search_graph(query.strip(), graph_path=graph_path, limit=limit),
    }


def get_legal_relations(
    document_id: str, max_hops: int = 1, limit: int = 20
) -> dict[str, Any]:
    if not isinstance(document_id, str) or not document_id.strip():
        raise ValueError("id must be a non-empty string")
    from legal_graph import get_relations

    graph_path = Path(os.getenv("LEGAL_GRAPH_PATH", "data/legal_graph.sqlite3"))
    return {
        "id": document_id,
        "results": get_relations(
            document_id.strip(), graph_path=graph_path, max_hops=max_hops, limit=limit
        ),
    }


def get_knowledge_status() -> dict[str, Any]:
    from legal_fts import index_status as legal_status
    from precedent_fts import index_status as precedent_status
    from legal_graph import graph_status
    from legal_ontology import ontology_contract, validate_graph_types
    from legal_vector import vector_status
    from okf_catalog import validate_bundle

    graph_path = Path(os.getenv("LEGAL_GRAPH_PATH", "data/legal_graph.sqlite3"))
    ontology_path = Path(os.getenv("LEGAL_ONTOLOGY_PATH", "ontology/legal-wiki.ttl"))
    okf_path = Path(os.getenv("OKF_BUNDLE_PATH", "okf/korea-legal"))
    graph = graph_status(graph_path)
    ontology_errors: list[str] = []
    if not ontology_path.is_file():
        ontology_errors.append(f"ontology not found: {ontology_path}")
    if graph["ready"]:
        ontology_errors.extend(validate_graph_types(graph_path, ontology_contract()))

    vector_config = _vector_config()
    if os.getenv("USE_QDRANT", "false").lower() == "true":
        if os.getenv("QDRANT_BACKEND", "memmap").lower() == "memmap":
            from legacy_vector_index import status as memmap_status

            vector = memmap_status(Path(os.getenv("VECTOR_MEMMAP_PATH", "data/vector_memmap")))
        else:
            vector = vector_status(vector_config)
    else:
        vector = {
            "ready": False,
            "collection": vector_config.collection,
            "model": vector_config.model,
            "dimension": vector_config.dimension,
            "points": 0,
            "reason": "disabled by USE_QDRANT=false (safe default)",
        }

    return {
        "server": SERVER_INFO,
        "lexical": {"laws": legal_status(), "precedents": precedent_status()},
        "vector": vector,
        "graph": graph,
        "ontology": {
            "ready": not ontology_errors,
            "path": str(ontology_path),
            "validation_errors": ontology_errors[:100],
        },
        "okf": {
            "ready": not (okf_errors := validate_bundle(okf_path)),
            "path": str(okf_path),
            "validation_errors": okf_errors,
        },
    }


def get_database_status() -> dict[str, Any]:
    """Compatibility alias for the complete knowledge-layer status."""
    return get_knowledge_status()


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "search_all":
        return search_all(arguments.get("query"), arguments.get("limit", 5))
    if name in {"search_laws", "search_legal_knowledge"}:
        return search_legal_knowledge(arguments.get("query"), arguments.get("limit", 5))
    if name == "get_law_article":
        return get_law_article(arguments.get("law_name"), arguments.get("article_number"))
    if name == "get_document":
        return get_document(arguments.get("id"))
    if name == "search_precedents":
        return search_precedents(arguments.get("query"), arguments.get("limit", 5))
    if name == "get_precedent":
        return get_precedent(arguments.get("id"), arguments.get("offset", 0), arguments.get("max_chars", 12000))
    if name == "find_case_number":
        return find_case_number(arguments.get("case_number"), arguments.get("limit", 5))
    if name == "search_legal_graph":
        return search_legal_graph(arguments.get("query"), arguments.get("limit", 5))
    if name == "get_legal_relations":
        return get_legal_relations(
            arguments.get("id"), arguments.get("max_hops", 1), arguments.get("limit", 20)
        )
    if name in {"get_database_status", "get_knowledge_status"}:
        return get_knowledge_status()
    raise ValueError(f"unknown tool: {name}")


def _format_tool_payload(payload: dict[str, Any]) -> str:
    if payload.get("status") == "indexing":
        return payload["message"]
    if "error" in payload:
        return f"Error: {payload['error']}"
    if {"lexical", "vector", "graph", "ontology", "okf"} <= payload.keys():
        laws = payload["lexical"]["laws"]
        precedents = payload["lexical"]["precedents"]
        return "\n".join(
            [
                f"korea-legal-rag {payload['server']['version']}",
                f"키워드/법령: ready={laws['ready']} documents={laws['documents']}",
                f"키워드/판례: ready={precedents['ready']} documents={precedents['documents']}",
                f"벡터: ready={payload['vector']['ready']} reason={payload['vector'].get('reason')}",
                f"그래프: ready={payload['graph']['ready']} nodes={payload['graph']['nodes']} edges={payload['graph']['edges']}",
                f"온톨로지: ready={payload['ontology']['ready']}",
                f"OKF: ready={payload['okf']['ready']}",
            ]
        )
    if "law_results" in payload:
        lines = [f"통합검색: {payload.get('query', '')}", f"법령 {len(payload['law_results'])}건 / 판례 {len(payload['precedent_results'])}건"]
        for label, items in (("법령", payload["law_results"]), ("판례", payload["precedent_results"])):
            lines.append(f"\n## {label}")
            for number, item in enumerate(items, start=1):
                title = item.get("case_name") or item.get("title") or item.get("id", "제목 없음")
                location = item.get("path") or item.get("source", "")
                excerpt = " ".join(item.get("excerpt", "").split())[:600]
                lines.extend([f"[{number}] {title}", f"id: {item.get('id', '')}", location, excerpt])
        return "\n".join(lines)
    if "results" in payload:
        lines = [f"Search: {payload.get('query', '')}", f"Results: {len(payload['results'])}"]
        for number, item in enumerate(payload["results"], start=1):
            title = item.get("case_name") or item.get("title") or item.get("id", "Untitled")
            location = item.get("path") or item.get("source", "")
            excerpt = " ".join(item.get("excerpt", "").split())[:600]
            lines.extend([f"\n[{number}] {title}", location, excerpt])
        return "\n".join(lines)
    if "text" in payload:
        header = payload.get("case_name") or payload.get("title") or payload.get("id", "문서")
        paging = ""
        if "offset" in payload:
            paging = f"\noffset={payload['offset']} total={payload.get('total_length')} has_more={payload.get('has_more')}"
        return f"{header}{paging}\n\n{payload['text']}"
    if "laws" in payload and "precedents" in payload:
        laws = payload["laws"]
        precedents = payload["precedents"]
        return (
            f"korea-legal-rag {payload['server']['version']}\n"
            f"법령: ready={laws['ready']} documents={laws['documents']} size_bytes={laws['size_bytes']}\n"
            f"판례: ready={precedents['ready']} documents={precedents['documents']} size_bytes={precedents['size_bytes']}"
        )
    return "Result returned."


def _tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": _format_tool_payload(payload)}],
    }


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _log(message: str) -> None:
    SERVER_LOG.parent.mkdir(parents=True, exist_ok=True)
    with SERVER_LOG.open("a", encoding="utf-8") as file:
        file.write(message + "\n")


def handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    method = request.get("method")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO},
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = request.get("params") or {}
        try:
            payload = call_tool(params.get("name"), params.get("arguments") or {})
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": request_id, "result": {**_tool_result({"error": str(exc)}), "isError": True}}
        return {"jsonrpc": "2.0", "id": request_id, "result": _tool_result(payload)}
    if request_id is None:
        return None
    return _error(request_id, -32601, f"method not found: {method}")


def serve() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    _log("server started")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            _log(f"request: {request.get('method')}")
            response = handle_request(request)
        except json.JSONDecodeError:
            _log("parse error")
            response = _error(None, -32700, "parse error")
        except Exception as exc:  # Never corrupt the stdio protocol with a traceback.
            _log(f"internal error: {type(exc).__name__}: {exc}")
            response = _error(None, -32603, str(exc))
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    serve()
