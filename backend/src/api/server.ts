import http from 'node:http';
import { errorResponse } from './http.js';
import { ApiRouter } from './router.js';

export function createApiServer(router: ApiRouter): http.Server {
  const server = http.createServer((req, res) => router.handle(req, res).catch(error => errorResponse(res, error)));
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return server;
}
