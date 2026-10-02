import type http from 'node:http';
import { AppError } from '../shared/app-error.js';
import { env } from '../config/env.js';

export const corsHeaders = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,last-event-id' };
export const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
  const origin = res.getHeader('access-control-allow-origin');
  const headers: http.OutgoingHttpHeaders = { ...corsHeaders };
  if (typeof origin === 'string') { headers['access-control-allow-origin'] = origin; headers.vary = 'Origin'; }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
};
export const readJson = async (req: http.IncomingMessage, maxBytes = env.maxRequestBytes): Promise<Record<string, unknown>> => {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new AppError(413, `maximum request body is ${maxBytes} bytes`);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new AppError(413, `maximum request body is ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  if (!bytes) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'request body must be a JSON object');
    return value as Record<string, unknown>;
  }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'request body must be valid JSON'); }
};
export const errorResponse = (res: http.ServerResponse, error: unknown): void => {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof AppError) return sendJson(res, error.statusCode, { error: error.message, details: error.details });
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_request_error', name: error instanceof Error ? error.name : 'unknown', at: new Date().toISOString() }));
  sendJson(res, 500, { error: 'internal server error' });
};
