import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiAuthenticator, createApiAuthToken } from '../src/api/authentication.ts';
import { ApiRouter } from '../src/api/router.ts';
import { validateRuntimeConfig } from '../src/config/env.ts';
import { errorResponse } from '../src/api/http.ts';
import { toLegalCapability } from '../src/application/capability-service.ts';

const token = 'a'.repeat(32);
const generatedToken = createApiAuthToken();
assert.match(generatedToken, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(createApiAuthToken(), generatedToken);
assert.throws(() => new ApiAuthenticator('short'), /at least 32 characters/);
assert.doesNotThrow(() => validateRuntimeConfig({ port: 8787 }));
assert.throws(() => validateRuntimeConfig({ port: 8787, apiAuthEnabled: true }), /API_AUTH_TOKEN must be set/);
assert.throws(() => validateRuntimeConfig({ port: 65_536, apiAuthToken: token }), /PORT must be an integer/);
assert.throws(() => validateRuntimeConfig({ port: 8787, apiAuthToken: token, maxBrowserSessions: 0 }), /MAX_BROWSER_SESSIONS must be a positive integer/);
assert.doesNotThrow(() => validateRuntimeConfig({ port: 8787, apiAuthEnabled: true, apiAuthToken: token }));
assert.doesNotThrow(() => new ApiAuthenticator().requireAuthorized(undefined));
const authenticator = new ApiAuthenticator(token);
let taskListCalls = 0;
const router = new ApiRouter({
  authenticator,
  tasks: { list: () => { taskListCalls++; return []; } },
  browser: { isAvailable: () => false },
  computer: { isAvailable: () => false },
  capabilities: { legalCapability: () => toLegalCapability({ enabled: true, root: 'C:/corpus', status: null }) },
} as never);
const server = http.createServer((req, res) => { void router.handle(req, res).catch(error => errorResponse(res, error)); });
server.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;
const origin = 'http://localhost:5173';

try {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).legalRetrieval, 'unknown');

  const missing = await fetch(`${baseUrl}/api/tasks`, { headers: { origin } });
  assert.equal(missing.status, 401);
  assert.equal(taskListCalls, 0);

  const malformed = await fetch(`${baseUrl}/api/tasks`, { headers: { origin, authorization: 'Basic abc' } });
  assert.equal(malformed.status, 401);
  assert.equal(taskListCalls, 0);

  const wrong = await fetch(`${baseUrl}/api/tasks`, { headers: { origin, authorization: `Bearer ${'b'.repeat(32)}` } });
  assert.equal(wrong.status, 401);
  assert.equal(taskListCalls, 0);

  const valid = await fetch(`${baseUrl}/api/tasks`, { headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(valid.status, 200);
  assert.equal(taskListCalls, 1);

  const previewOrigin = 'http://localhost:3001';
  const previewRequest = await fetch(`${baseUrl}/api/tasks`, {
    headers: { origin: previewOrigin, authorization: `Bearer ${token}` },
  });
  assert.equal(previewRequest.status, 200, 'the isolated frontend preview origin must be allowed');
  assert.equal(previewRequest.headers.get('access-control-allow-origin'), previewOrigin);
  assert.equal(taskListCalls, 2);

  const unauthenticatedUnknownApiRoute = await fetch(`${baseUrl}/api/computer/approvals`, { method: 'POST', headers: { origin } });
  assert.equal(unauthenticatedUnknownApiRoute.status, 401);
  const oldApprovalRoute = await fetch(`${baseUrl}/api/computer/approvals`, {
    method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'click' }),
  });
  assert.equal(oldApprovalRoute.status, 404);

  const blockedOrigin = await fetch(`${baseUrl}/api/tasks`, { headers: { origin: 'http://evil.example' } });
  assert.equal(blockedOrigin.status, 403);
  assert.equal(taskListCalls, 2);

  const preflight = await fetch(`${baseUrl}/api/tasks`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /GET/);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.equal(taskListCalls, 2);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('API authentication integration tests passed');
