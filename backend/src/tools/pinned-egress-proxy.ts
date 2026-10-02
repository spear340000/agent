import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';
import { AppError } from '../shared/app-error.js';
import { resolvePublicHttpTarget, type HostResolver } from './public-url.js';

export type EgressProxyOptions = {
  resolveHost?: HostResolver;
  connect?: (address: string, port: number) => Socket;
  maxConnections?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
};

const hopByHopHeaders = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function filteredHeaders(headers: http.IncomingHttpHeaders, host?: string): http.OutgoingHttpHeaders {
  const removed = new Set(hopByHopHeaders);
  for (const token of String(headers.connection ?? '').split(',')) if (token.trim()) removed.add(token.trim().toLowerCase());
  const output: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !removed.has(name.toLowerCase())) output[name] = value;
  if (host) output.host = host;
  return output;
}

export class PinnedEgressProxy {
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly resolveHost: HostResolver | undefined;
  private readonly connect: (address: string, port: number) => Socket;
  private readonly maxConnections: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private listenPromise: Promise<string> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: EgressProxyOptions = {}) {
    this.resolveHost = options.resolveHost;
    this.connect = options.connect ?? ((address, port) => net.connect({ host: address, port, family: net.isIP(address) }));
    this.maxConnections = options.maxConnections ?? 100;
    this.maxRequestBytes = options.maxRequestBytes ?? 16 * 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1) throw new Error('maxConnections must be a positive integer');
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('proxy byte limits must be positive integers');
    this.server = http.createServer((request, response) => { void this.forwardHttp(request, response); });
    this.server.on('connect', (request, client, head) => { void this.forwardTunnel(request, client as Socket, head); });
    this.server.on('upgrade', (request, client, head) => { void this.forwardUpgrade(request, client as Socket, head); });
    this.server.on('connection', socket => this.trackSocket(socket));
    this.server.maxConnections = this.maxConnections;
    this.server.maxHeadersCount = 100;
    this.server.headersTimeout = 30_000;
    this.server.requestTimeout = 120_000;
  }

  listen(): Promise<string> {
    if (this.closing) return Promise.reject(new Error('egress proxy is closing'));
    if (this.listenPromise) return this.listenPromise;
    this.listenPromise = new Promise<string>((resolve, reject) => {
      const fail = (error: Error): void => { this.listenPromise = undefined; reject(error); };
      this.server.once('error', fail);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', fail);
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('egress proxy failed to bind an IP socket'));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.listenPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>(resolve => {
      if (!this.server.listening) { resolve(); return; }
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
    return this.closePromise;
  }

  private async resolveTarget(value: string, tunnel = false): Promise<{ url: URL; address: string; port: number }> {
    const target = await resolvePublicHttpTarget(value, this.resolveHost);
    const port = Number(target.url.port || (target.url.protocol === 'https:' ? 443 : 80));
    if (tunnel && ![80, 443].includes(port)) throw new AppError(400, 'only HTTP(S) ports 80 and 443 are allowed');
    const address = target.addresses[0]?.address;
    if (!address) throw new AppError(403, 'destination could not be resolved');
    return { url: target.url, address, port };
  }

  private async forwardHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let upstream: http.ClientRequest | undefined;
    request.once('aborted', () => upstream?.destroy());
    response.once('close', () => upstream?.destroy());
    try {
      if (this.closing) throw new AppError(503, 'egress proxy is shutting down');
      const target = await this.resolveTarget(request.url ?? '');
      if (this.closing || request.aborted || response.destroyed) return;
      const declaredRequestBytes = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > this.maxRequestBytes) throw new AppError(413, 'request exceeds proxy byte limit');
      let requestBytes = 0;
      request.on('data', (chunk: Buffer) => {
        requestBytes += chunk.length;
        if (requestBytes > this.maxRequestBytes) {
          upstream?.destroy();
          if (!response.headersSent && !response.destroyed) { response.writeHead(413, { connection: 'close' }); response.end('request exceeds proxy byte limit'); }
          else response.destroy();
        }
      });
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => this.openSocket(target.address, target.port);
      upstream = http.request({
        hostname: target.address,
        family: net.isIP(target.address),
        port: target.port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: filteredHeaders(request.headers, target.url.host),
        agent,
      }, upstreamResponse => {
        const declaredResponseBytes = Number(upstreamResponse.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredResponseBytes) && declaredResponseBytes > this.maxResponseBytes) {
          upstreamResponse.destroy();
          if (!response.destroyed) { response.writeHead(413, { connection: 'close' }); response.end('response exceeds proxy byte limit'); }
          return;
        }
        let responseBytes = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > this.maxResponseBytes) { upstreamResponse.destroy(); response.destroy(); }
        });
        const headers = filteredHeaders(upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(120_000, () => upstream?.destroy(new Error('upstream timeout')));
      upstream.once('error', error => { if (!response.headersSent) response.writeHead(502, { 'connection': 'close' }); response.end(error.message === 'upstream timeout' ? 'upstream timeout' : 'upstream unavailable'); });
      request.pipe(upstream);
    } catch (error) {
      upstream?.destroy();
      this.rejectHttp(response, error);
    }
  }

  private async forwardTunnel(request: http.IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    let upstream: Socket | undefined;
    client.once('close', () => upstream?.destroy());
    try {
      if (this.closing) throw new AppError(503, 'egress proxy is shutting down');
      const authority = request.url ?? '';
      const target = await this.resolveTarget(`https://${authority}/`, true);
      if (this.closing || client.destroyed) return;
      upstream = this.openSocket(target.address, target.port);
      upstream.setTimeout(120_000, () => upstream?.destroy());
      upstream.once('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      upstream.once('connect', () => {
        if (client.destroyed || this.closing) { upstream?.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream?.write(head);
        client.pipe(upstream!).pipe(client);
      });
    } catch {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      upstream?.destroy();
    }
  }

  private async forwardUpgrade(request: http.IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    let upstream: http.ClientRequest | undefined;
    client.once('close', () => upstream?.destroy());
    try {
      if (this.closing) throw new AppError(503, 'egress proxy is shutting down');
      const target = await this.resolveTarget(request.url ?? '');
      if (this.closing || client.destroyed) return;
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => this.openSocket(target.address, target.port);
      upstream = http.request({
        hostname: target.address,
        family: net.isIP(target.address),
        port: target.port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: { ...filteredHeaders(request.headers, target.url.host), connection: 'Upgrade', upgrade: request.headers.upgrade },
        agent,
      });
      upstream.once('upgrade', (upstreamResponse, socket, responseHead) => {
        const headers = { ...filteredHeaders(upstreamResponse.headers), connection: 'Upgrade', upgrade: upstreamResponse.headers.upgrade };
        client.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`);
        for (const [name, value] of Object.entries(headers)) if (value !== undefined) client.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
        client.write('\r\n');
        if (responseHead.length) client.write(responseHead);
        if (head.length) socket.write(head);
        client.pipe(socket).pipe(client);
        client.once('close', () => socket.destroy());
      });
      upstream.once('response', result => {
        client.write(`HTTP/1.1 ${result.statusCode ?? 502} ${result.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
        result.pipe(client);
      });
      upstream.once('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      upstream.end();
    } catch {
      upstream?.destroy();
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  }

  private rejectHttp(response: http.ServerResponse, error: unknown): void {
    const status = error instanceof AppError ? error.statusCode === 503 || error.statusCode === 413 ? error.statusCode : 403 : 502;
    if (!response.headersSent) response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    response.end(status === 403 ? 'destination blocked' : status === 413 ? 'request exceeds proxy byte limit' : status === 503 ? 'proxy shutting down' : 'upstream unavailable');
  }

  private openSocket(address: string, port: number): Socket {
    if (this.closing) throw new Error('egress proxy is shutting down');
    return this.trackSocket(this.connect(address, port));
  }

  private trackSocket<T extends Socket>(socket: T): T {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(120_000, () => socket.destroy());
    if (this.closing) socket.destroy();
    return socket;
  }
}
