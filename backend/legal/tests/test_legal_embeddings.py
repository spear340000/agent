import json

import httpx
import pytest

from legal_embeddings import (
    EmbeddingConfig,
    EmbeddingError,
    EmbeddingUnavailable,
    NvidiaEmbedder,
)


class RecordingTransport(httpx.BaseTransport):
    """A local HTTP transport that records complete requests and closure."""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []
        self.closed = False

    def handle_request(self, request):
        self.requests.append(request)
        return self.handler(request)

    def close(self):
        self.closed = True


def test_embedding_config_uses_the_required_nvidia_defaults():
    config = EmbeddingConfig()

    assert config.model == "nvidia/nemotron-3-embed-1b"
    assert config.dimension == 2048
    assert config.timeout > 0


def test_embedding_config_rejects_an_empty_model_name():
    with pytest.raises(ValueError, match="model"):
        EmbeddingConfig(model="")


def test_embedding_config_rejects_a_non_positive_dimension():
    with pytest.raises(ValueError, match="dimension"):
        EmbeddingConfig(dimension=0)


def test_embedding_config_rejects_a_non_positive_batch_size():
    with pytest.raises(ValueError, match="batch size"):
        EmbeddingConfig(batch_size=0)


def test_embedder_uses_the_api_key_available_at_construction(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "first-key")

    def respond(request):
        assert request.headers["authorization"] == "Bearer first-key"
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.25, 0.5, 0.75]}]},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)
    monkeypatch.setenv("NVIDIA_API_KEY", "second-key")

    assert embedder.embed(["형법"], input_type="query") == [[0.25, 0.5, 0.75]]
    assert transport.closed is True


def test_embedder_without_a_construction_time_key_is_unavailable(monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)

    with pytest.raises(EmbeddingUnavailable, match="NVIDIA_API_KEY"):
        NvidiaEmbedder()


def test_embed_posts_nim_passage_request_returns_vectors_and_closes_client(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        assert request.url == httpx.URL("https://integrate.api.nvidia.com/v1/embeddings")
        assert request.headers["authorization"] == "Bearer test-key"
        assert json.loads(request.content) == {
            "model": "nvidia/nemotron-3-embed-1b",
            "input": ["대한민국 형법"],
            "input_type": "passage",
        }
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.25, 0.5, 0.75]}]},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(
        EmbeddingConfig(dimension=3), transport=transport
    )

    assert embedder.embed(["대한민국 형법"], input_type="passage") == [
        [0.25, 0.5, 0.75]
    ]
    assert len(transport.requests) == 1
    assert transport.closed is True


def test_embed_rejects_a_result_count_that_does_not_match_inputs(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.25, 0.5, 0.75]}]},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="result count"):
        embedder.embed(["형법", "민법"], input_type="passage")

    assert transport.closed is True


def test_embed_converts_a_malformed_nvidia_response_to_embedding_error(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(200, json={"unexpected": []}, request=request)

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="malformed"):
        embedder.embed(["형법"], input_type="passage")

    assert transport.closed is True


@pytest.mark.parametrize("item", [{}, "not-an-object"])
def test_embed_converts_a_malformed_result_item_to_embedding_error(monkeypatch, item):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(200, json={"data": [item]}, request=request)

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="malformed"):
        embedder.embed(["형법"], input_type="passage")

    assert transport.closed is True


def test_embed_rejects_an_unsupported_input_type_before_http(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    transport = RecordingTransport(lambda request: pytest.fail("HTTP must not run"))
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="input_type"):
        embedder.embed(["형법"], input_type="document")

    assert transport.requests == []


def test_embed_rejects_a_vector_with_the_wrong_dimension(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.25, 0.5]}]},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="dimension"):
        embedder.embed(["형법"], input_type="passage")

    assert transport.closed is True


def test_embed_rejects_a_vector_with_non_finite_values(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(
            200,
            content=b'{"data":[{"embedding":[NaN,0.5,0.75]}]}',
            headers={"content-type": "application/json"},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingError, match="non-finite"):
        embedder.embed(["형법"], input_type="passage")

    assert transport.closed is True


def test_embed_retries_transient_nvidia_failures_up_to_a_success(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        if len(transport.requests) < 3:
            return httpx.Response(503, json={"error": "busy"}, request=request)
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.25, 0.5, 0.75]}]},
            request=request,
        )

    transport = RecordingTransport(respond)
    delays = []
    embedder = NvidiaEmbedder(
        EmbeddingConfig(dimension=3), transport=transport, sleeper=delays.append
    )

    assert embedder.embed(["형법"], input_type="query") == [[0.25, 0.5, 0.75]]
    assert len(transport.requests) == 3
    assert delays == [0.1, 0.2]
    assert transport.closed is True


def test_embed_does_not_retry_or_back_off_a_non_transient_http_error(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def respond(request):
        return httpx.Response(400, json={"error": "invalid input"}, request=request)

    transport = RecordingTransport(respond)
    delays = []
    embedder = NvidiaEmbedder(
        EmbeddingConfig(dimension=3), transport=transport, sleeper=delays.append
    )

    with pytest.raises(EmbeddingUnavailable, match="400"):
        embedder.embed(["형법"], input_type="query")

    assert len(transport.requests) == 1
    assert delays == []
    assert transport.closed is True


def test_embed_reports_network_unavailability_after_three_attempts(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")

    def offline(request):
        raise httpx.ConnectError("offline", request=request)

    transport = RecordingTransport(offline)
    embedder = NvidiaEmbedder(EmbeddingConfig(dimension=3), transport=transport)

    with pytest.raises(EmbeddingUnavailable, match="request failed"):
        embedder.embed(["형법"], input_type="query")

    assert len(transport.requests) == 3
    assert transport.closed is True


def test_embed_splits_inputs_into_bounded_batches_and_preserves_order(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    vectors = {
        "형법": [1.0, 0.0, 0.0],
        "민법": [0.0, 1.0, 0.0],
        "상법": [0.0, 0.0, 1.0],
    }

    def respond(request):
        payload = json.loads(request.content)
        return httpx.Response(
            200,
            json={"data": [{"embedding": vectors[text]} for text in payload["input"]]},
            request=request,
        )

    transport = RecordingTransport(respond)
    embedder = NvidiaEmbedder(
        EmbeddingConfig(dimension=3, batch_size=2), transport=transport
    )

    assert embedder.embed(["형법", "민법", "상법"], input_type="passage") == [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ]
    assert [json.loads(request.content)["input"] for request in transport.requests] == [
        ["형법", "민법"],
        ["상법"],
    ]
    assert transport.closed is True
