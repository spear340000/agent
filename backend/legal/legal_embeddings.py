"""Isolated NVIDIA NIM embedding adapter for legal retrieval."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import math
import os
import time
from typing import Literal, Protocol, Sequence

import httpx

InputType = Literal["query", "passage"]


class EmbeddingError(RuntimeError):
    """An embedding response could not be used safely."""


class EmbeddingUnavailable(EmbeddingError):
    """The embedding service is not available for the current operation."""


class Embedder(Protocol):
    def embed(self, texts: Sequence[str], input_type: InputType) -> list[list[float]]:
        """Embed passages or a query."""


@dataclass(frozen=True)
class EmbeddingConfig:
    model: str = "nvidia/nemotron-3-embed-1b"
    dimension: int = 2048
    timeout: float = 30.0
    batch_size: int = 64
    base_url: str | None = None

    def __post_init__(self) -> None:
        if not self.model.strip():
            raise ValueError("embedding model must not be empty")
        if self.dimension <= 0:
            raise ValueError("embedding dimension must be positive")
        if self.batch_size <= 0:
            raise ValueError("embedding batch size must be positive")


class NvidiaEmbedder:
    """Calls NVIDIA NIM embeddings without importing application state."""

    _DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
    _TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}
    _MAX_ATTEMPTS = 3
    _BACKOFF_BASE_SECONDS = 0.1
    _MAX_BACKOFF_SECONDS = 0.5

    def __init__(
        self,
        config: EmbeddingConfig | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config or EmbeddingConfig()
        self._api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not self._api_key:
            raise EmbeddingUnavailable("NVIDIA_API_KEY is not configured")
        base_url = (
            self.config.base_url
            or os.getenv("NVIDIA_BASE_URL")
            or self._DEFAULT_BASE_URL
        )
        self._endpoint = base_url.rstrip("/") + "/embeddings"
        self._transport = transport
        self._sleeper = sleeper

    def embed(
        self, texts: Sequence[str], input_type: InputType = "passage"
    ) -> list[list[float]]:
        if input_type not in {"query", "passage"}:
            raise EmbeddingError("input_type must be 'query' or 'passage'")
        items = list(texts)
        vectors: list[list[float]] = []
        with httpx.Client(timeout=self.config.timeout, transport=self._transport) as client:
            for start in range(0, len(items), self.config.batch_size):
                batch = items[start : start + self.config.batch_size]
                response = self._post_with_retries(client, batch, input_type)
                vectors.extend(self._validate_response(response, len(batch)))
        return vectors

    def _validate_response(
        self, response: httpx.Response, expected_count: int
    ) -> list[list[float]]:
        try:
            data = response.json()["data"]
            if not isinstance(data, list):
                raise TypeError("data must be a list")
            vectors = []
            for item in data:
                if not isinstance(item, dict):
                    raise TypeError("result item must be an object")
                vector = item["embedding"]
                if not isinstance(vector, list):
                    raise TypeError("embedding must be a list")
                vectors.append(vector)
        except (KeyError, TypeError, ValueError) as exc:
            raise EmbeddingError("NVIDIA embedding response is malformed") from exc
        if len(data) != expected_count:
            raise EmbeddingError("NVIDIA embedding result count does not match input")
        if any(len(vector) != self.config.dimension for vector in vectors):
            raise EmbeddingError("NVIDIA embedding vector has the wrong dimension")
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            for vector in vectors
            for value in vector
        ):
            raise EmbeddingError("NVIDIA embedding vector contains a non-finite value")
        return vectors

    def _post_with_retries(
        self, client: httpx.Client, texts: list[str], input_type: InputType
    ) -> httpx.Response:
        payload = {
            "model": self.config.model,
            "input": texts,
            "input_type": input_type,
        }
        for attempt in range(self._MAX_ATTEMPTS):
            try:
                response = client.post(
                    self._endpoint,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json=payload,
                )
            except httpx.RequestError as exc:
                if attempt + 1 < self._MAX_ATTEMPTS:
                    self._sleep_before_retry(attempt)
                    continue
                raise EmbeddingUnavailable("NVIDIA embedding request failed") from exc
            if response.status_code in self._TRANSIENT_STATUS_CODES:
                if attempt + 1 < self._MAX_ATTEMPTS:
                    self._sleep_before_retry(attempt)
                    continue
                raise EmbeddingUnavailable(
                    f"NVIDIA embedding service returned {response.status_code}"
                )
            if response.is_error:
                raise EmbeddingUnavailable(
                    f"NVIDIA embedding service returned {response.status_code}"
                )
            return response
        raise AssertionError("embedding retry loop ended unexpectedly")

    def _sleep_before_retry(self, attempt: int) -> None:
        delay = min(
            self._BACKOFF_BASE_SECONDS * (2**attempt), self._MAX_BACKOFF_SECONDS
        )
        self._sleeper(delay)
