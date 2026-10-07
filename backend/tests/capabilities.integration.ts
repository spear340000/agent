import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ApiAuthenticator } from "../src/api/authentication.ts";
import { errorResponse } from "../src/api/http.ts";
import { ApiRouter } from "../src/api/router.ts";
import {
  CapabilityService,
  toLegalCapability,
} from "../src/application/capability-service.ts";

const token = "capability-test-token-0123456789abcdef";
const legal = toLegalCapability({
  enabled: true,
  root: "C:/corpus",
  status: null,
});
const expected = {
  model: { configured: false, provider: null, name: "test-model", fallbacks: [] },
  browserUse: { available: false },
  computerUse: { available: false, platform: process.platform },
  legalRetrieval: legal,
  office: {
    docx: true,
    xlsx: true,
    pdf: true,
    ocr: false,
    googleDocs: false,
    googleSheets: false,
    formulaCalculation: false,
  },
};
const router = new ApiRouter({
  authenticator: new ApiAuthenticator(token),
  capabilities: {
    getCapabilities: () => expected,
    legalCapability: () => legal,
  },
  browser: { isAvailable: () => false },
  computer: { isAvailable: () => false },
} as never);
const server = http.createServer((request, response) => {
  void router
    .handle(request, response)
    .catch((error) => errorResponse(response, error));
});
server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  assert.equal((await fetch(`${baseUrl}/api/capabilities`)).status, 401);
  const response = await fetch(`${baseUrl}/api/capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, expected);
  assert.equal(JSON.stringify(body).includes(token), false);
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.legalRetrieval, legal.state);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("legal retrieval readiness is probed and reported apart from the model key", async () => {
  let probes = 0;
  const service = new CapabilityService(
    {
      modelConfigured: true,
      modelName: "test-model",
      browserAvailable: false,
      computerAvailable: false,
      platform: process.platform,
      legal: toLegalCapability({
        enabled: true,
        root: "C:/corpus",
        status: null,
      }),
    },
    {
      maxAgeMs: 60_000,
      read: async () => {
        probes += 1;
        return null;
      },
    },
  );
  const before = await service.getCapabilities();
  assert.equal(before.model.configured, true);
  assert.equal(before.model.name, "test-model");
  assert.equal(before.legalRetrieval.ready, false);
  assert.equal(before.legalRetrieval.state, "unknown");
  assert.equal(probes, 1);
  await service.getCapabilities();
  assert.equal(probes, 1, "the probe result is cached");
  service.setLegal(
    toLegalCapability({
      enabled: true,
      root: "C:/corpus",
      status: {
        server: null,
        laws: { ready: true, documents: 10 },
        precedents: { ready: true, documents: 5 },
        vector: { ready: false, reason: "disabled" },
        graph: { ready: false },
        ontology: { ready: false },
        okf: { ready: false },
        degraded: ["vector"],
        parsed: true,
      },
    }),
  );
  const after = await service.getCapabilities();
  assert.equal(after.legalRetrieval.ready, true);
  assert.equal(after.legalRetrieval.corpus.laws, 10);
  assert.equal(after.legalRetrieval.vector.ready, false);
});

test("runtime capabilities identify the configured model without exposing credentials", async () => {
  const service = new CapabilityService({
    modelConfigured: true,
    modelName: "gpt-6-luna",
    browserAvailable: false,
    computerAvailable: false,
    platform: process.platform,
    legal,
  });
  const result = await service.getCapabilities();
  assert.deepEqual(result.model, {
    configured: true,
    provider: "openai-compatible",
    name: "gpt-6-luna",
    fallbacks: [],
    providers: [],
  });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("runtime capabilities disclose configured fallback model names but never provider credentials", async () => {
  const service = new CapabilityService({
    modelConfigured: true,
    modelName: "nvidia/primary",
    modelFallbacks: ["NVIDIA NIM · nvidia/nemotron-3-super-120b-a12b", "NVIDIA NIM · nvidia/nemotron-3.5-lightning-30b-a3b"],
    browserAvailable: false,
    computerAvailable: false,
    platform: process.platform,
    legal,
  });
  const result = await service.getCapabilities();
  assert.deepEqual(result.model.fallbacks, ["NVIDIA NIM · nvidia/nemotron-3-super-120b-a12b", "NVIDIA NIM · nvidia/nemotron-3.5-lightning-30b-a3b"]);
  assert.equal(JSON.stringify(result).includes(token), false);
});

console.log("capability integration tests passed");
