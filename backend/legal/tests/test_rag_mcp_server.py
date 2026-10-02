import json
import os
from pathlib import Path
import subprocess
import sys


def test_startup_refuses_missing_indexes_without_rebuilding(monkeypatch):
    import legal_fts
    import precedent_fts
    import rag_mcp_server

    monkeypatch.setattr(legal_fts, "index_ready", lambda: False)
    monkeypatch.setattr(precedent_fts, "index_ready", lambda: False)
    monkeypatch.setattr(
        legal_fts,
        "ensure_index",
        lambda: (_ for _ in ()).throw(AssertionError("must not rebuild corpus")),
    )

    try:
        rag_mcp_server.load_knowledge()
    except RuntimeError as error:
        assert "read-only legal indexes are missing" in str(error)
    else:
        raise AssertionError("missing indexes must fail closed")


def test_search_tool_returns_retrieval_hits_without_answer_generation(monkeypatch):
    import rag_mcp_server
    import legal_fts

    text = "형법\n제122조(직무유기) 공무원이 정당한 이유 없이 직무수행을 거부하면 처벌한다."
    monkeypatch.setattr(
        legal_fts,
        "search_index",
        lambda query, limit: [{"id": "criminal:122", "title": "형법", "source": "criminal", "text": text, "score": 1.0, "backend": "sqlite-fts"}],
    )
    monkeypatch.setattr(rag_mcp_server, "_KNOWLEDGE_LOADED", True)

    result = rag_mcp_server.call_tool("search_legal_knowledge", {"query": "직무유기", "limit": 1})

    assert result["query"] == "직무유기"
    assert result["results"][0]["id"] == "criminal:122"
    assert result["results"][0]["excerpt"] == text


def test_tools_list_exposes_search_and_document_lookup():
    import rag_mcp_server

    tools = rag_mcp_server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

    names = {tool["name"] for tool in tools["result"]["tools"]}
    assert {
        "search_all",
        "search_laws",
        "get_law_article",
        "search_precedents",
        "get_precedent",
        "find_case_number",
        "get_database_status",
    } <= names
    assert {"search_legal_knowledge", "get_document"} <= names
    assert {"search_legal_graph", "get_legal_relations", "get_knowledge_status"} <= names
    assert "한국어 법률 용어" in tools["result"]["tools"][0]["description"]
    get_precedent_tool = next(tool for tool in tools["result"]["tools"] if tool["name"] == "get_precedent")
    assert "판례일련번호" in get_precedent_tool["description"]
    assert "사건번호" in get_precedent_tool["description"]


def test_search_all_returns_laws_and_precedents(monkeypatch):
    import rag_mcp_server

    class FakeRetriever:
        def search(self, query, *, corpus, limit):
            from hybrid_retrieval import HybridSearchResult
            return HybridSearchResult(
                query=query,
                corpus=corpus,
                results=[{"id": "law:1", "channels": ["lexical", "graph"]}],
                backends={"lexical": {"ready": True}, "graph": {"ready": True}},
            )

    monkeypatch.setattr(rag_mcp_server, "create_retriever", lambda: FakeRetriever())

    result = rag_mcp_server.call_tool("search_all", {"query": "위법성", "limit": 3})

    assert result["results"][0]["id"] == "law:1"
    assert result["results"][0]["channels"] == ["lexical", "graph"]


def test_initialize_does_not_start_knowledge_loading(monkeypatch):
    import rag_mcp_server

    calls = []
    monkeypatch.setattr(rag_mcp_server, "_start_knowledge_load", lambda: calls.append(True))
    monkeypatch.setattr(
        rag_mcp_server,
        "create_retriever",
        lambda: (_ for _ in ()).throw(AssertionError("retriever opened during initialize")),
        raising=False,
    )

    response = rag_mcp_server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

    assert response["result"]["capabilities"] == {"tools": {}}
    assert calls == []
    assert response["result"]["serverInfo"]["name"] == "korea-legal-rag"


def test_search_precedents_finds_matching_case_without_loading_legal_corpus(tmp_path, monkeypatch):
    import rag_mcp_server
    import precedent_rag
    import precedent_fts

    case = tmp_path / "대법원_2024-01-01_2023도100.md"
    case.write_text("# 판례\n\n직무유기에 관한 판결 이유입니다.", encoding="utf-8")
    monkeypatch.setenv("USE_QDRANT", "false")
    monkeypatch.setattr(precedent_fts, "index_ready", lambda: True)
    monkeypatch.setattr(
        precedent_fts,
        "search_index",
        lambda query, limit: [{"id": str(case), "case_name": case.stem, "path": str(case), "excerpt": "직무유기에 관한 판결 이유입니다.", "score": 1.0, "backend": "sqlite-fts"}],
    )
    monkeypatch.setattr(
        precedent_rag,
        "search_precedent_vectors",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Qdrant must stay disabled")),
    )
    result = rag_mcp_server.search_precedents("직무유기", limit=1)

    assert result["results"][0]["case_name"] == "대법원_2024-01-01_2023도100"
    assert "직무유기" in result["results"][0]["excerpt"]
    assert result["mode"] == "hybrid-rag"


def test_tool_result_matches_2024_protocol_without_structured_content():
    import rag_mcp_server

    result = rag_mcp_server._tool_result({"query": "직무유기", "results": []})

    assert result["content"][0]["type"] == "text"
    assert not result["content"][0]["text"].startswith("{")
    assert "structuredContent" not in result


def test_embedding_failure_never_writes_to_mcp_stdout(monkeypatch, capsys):
    from legal_embeddings import EmbeddingConfig, EmbeddingUnavailable, NvidiaEmbedder

    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    import httpx
    transport = httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ConnectError("offline")))
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=4), transport=transport, sleeper=lambda _: None)
    try:
        embedder.embed(["직무유기"], "query")
    except EmbeddingUnavailable:
        pass
    else:
        raise AssertionError("network failure was not translated")
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_lm_studio_utf8_korean_request_survives_windows_cp949_stdio():
    root = Path(__file__).resolve().parents[1]
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "lm-studio", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_legal_knowledge", "arguments": {"query": "위법성 조각 성실한 관리자의 주의 의무", "limit": 1}}},
    ]
    wire_input = "\n".join(json.dumps(item, ensure_ascii=False) for item in requests) + "\n"
    environment = os.environ.copy()
    environment.update({"PYTHONIOENCODING": "cp949:surrogateescape", "USE_QDRANT": "false"})

    completed = subprocess.run(
        [sys.executable, str(root / "rag_mcp_server.py")],
        input=wire_input.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=root,
        env=environment,
        timeout=15,
    )

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    responses = [json.loads(line) for line in completed.stdout.decode("utf-8").splitlines()]
    assert responses[-1]["id"] == 2
