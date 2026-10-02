import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { PinnedEgressProxy } from '../src/tools/pinned-egress-proxy.ts';

const upstream = http.createServer((req, res) => {
  if (req.url === '/oversized') { res.writeHead(200, { 'content-length': '1024' }); res.end('x'.repeat(1024)); return; }
  if (req.url === '/stream-oversized') { res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write('x'.repeat(300)); setTimeout(() => res.end('x'.repeat(300)), 10); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`host=${req.headers.host};path=${req.url}`);
});
const testSockets = new Set<net.Socket>();
upstream.on('connection', socket => { testSockets.add(socket); socket.once('close', () => testSockets.delete(socket)); });
upstream.on('upgrade', (_req, socket, head) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  if (head.length) socket.write(head);
  socket.on('data', chunk => socket.write(chunk));
});
upstream.listen(0, '127.0.0.1');
await new Promise<void>(resolve => upstream.once('listening', resolve));
const upstreamPort = (upstream.address() as net.AddressInfo).port;
const tunnelUpstream = net.createServer(socket => socket.pipe(socket));
tunnelUpstream.on('connection', socket => { testSockets.add(socket); socket.once('close', () => testSockets.delete(socket)); });
tunnelUpstream.listen(0, '127.0.0.1');
await new Promise<void>(resolve => tunnelUpstream.once('listening', resolve));
const tunnelPort = (tunnelUpstream.address() as net.AddressInfo).port;
const dialed: Array<{ address: string; port: number }> = [];
let resolution = [{ address: '93.184.216.34', family: 4 }];
let flipAfterResolve = false;
const proxy = new PinnedEgressProxy({
  resolveHost: async () => {
    const answer = resolution;
    if (flipAfterResolve) resolution = [{ address: '127.0.0.1', family: 4 }];
    return answer;
  },
  connect: (address, port) => { dialed.push({ address, port }); return net.connect({ host: '127.0.0.1', port: port === 443 ? tunnelPort : upstreamPort }); },
  maxRequestBytes: 32,
  maxResponseBytes: 512,
});

try {
  const proxyUrl = await proxy.listen();
  const parsedProxy = new URL(proxyUrl);
  flipAfterResolve = true;
  const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: parsedProxy.hostname, port: parsedProxy.port, path: 'http://public-example.com/document?q=1', method: 'GET' }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'host=public-example.com;path=/document?q=1');
  assert.deepEqual(dialed[0], { address: '93.184.216.34', port: 80 });
  flipAfterResolve = false;
  resolution = [{ address: '93.184.216.34', family: 4 }];

  const tunnel = await new Promise<{ statusLine: string; echo: string }>((resolve, reject) => {
    const client = net.connect({ host: parsedProxy.hostname, port: Number(parsedProxy.port) });
    const timer = setTimeout(() => { client.destroy(); reject(new Error(`CONNECT tunnel timed out: ${received.toString('utf8')} dialed=${JSON.stringify(dialed)}`)); }, 5_000);
    let received = Buffer.alloc(0);
    let sent = false;
    client.once('error', error => { clearTimeout(timer); reject(error); });
    client.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf('\r\n\r\n');
      if (boundary >= 0 && !sent) {
        sent = true;
        const statusLine = received.subarray(0, boundary).toString('utf8').split('\r\n')[0]!;
        client.write('pinned-tunnel-check');
        const tail = received.subarray(boundary + 4).toString('utf8');
        if (tail.includes('pinned-tunnel-check')) { clearTimeout(timer); client.end(); resolve({ statusLine, echo: tail }); }
        return;
      }
      if (sent && received.toString('utf8').includes('pinned-tunnel-check')) {
        const text = received.toString('utf8');
        const marker = text.indexOf('pinned-tunnel-check', text.indexOf('\r\n\r\n') + 4);
        if (marker >= 0) { clearTimeout(timer); client.end(); resolve({ statusLine: text.split('\r\n')[0]!, echo: text.slice(marker) }); }
      }
    });
    client.once('connect', () => client.write('CONNECT public-example.com:443 HTTP/1.1\r\nHost: public-example.com:443\r\n\r\n'));
  });
  assert.match(tunnel.statusLine, /200 Connection Established/);
  assert.match(tunnel.echo, /pinned-tunnel-check/);
  assert.deepEqual(dialed[1], { address: '93.184.216.34', port: 443 });

  const websocket = await new Promise<{ statusLine: string; echo: string }>((resolve, reject) => {
    const client = net.connect({ host: parsedProxy.hostname, port: Number(parsedProxy.port) });
    const timer = setTimeout(() => { client.destroy(); reject(new Error('WebSocket upgrade timed out')); }, 5_000);
    let received = Buffer.alloc(0);
    let sent = false;
    client.once('error', error => { clearTimeout(timer); reject(error); });
    client.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const text = received.toString('utf8');
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary >= 0 && !sent) { sent = true; client.write('upgrade-pinned-check'); return; }
      const echoAt = text.indexOf('upgrade-pinned-check', boundary + 4);
      if (echoAt >= 0) { clearTimeout(timer); client.end(); resolve({ statusLine: text.slice(0, boundary).split('\r\n')[0]!, echo: text.slice(echoAt) }); }
    });
    client.once('connect', () => client.write('GET http://public-example.com/socket HTTP/1.1\r\nHost: public-example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
  });
  assert.match(websocket.statusLine, /101 Switching Protocols/);
  assert.match(websocket.echo, /upgrade-pinned-check/);
  assert.deepEqual(dialed[2], { address: '93.184.216.34', port: 80 });

  const dialCount = dialed.length;
  resolution = [{ address: '127.0.0.1', family: 4 }];
  const blocked = await new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname: parsedProxy.hostname, port: parsedProxy.port, path: 'http://public-example.com/private', method: 'GET' }, result => {
      result.resume();
      result.on('end', () => resolve(result.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(blocked, 403);
  assert.equal(dialed.length, dialCount);
  resolution = [{ address: '93.184.216.34', family: 4 }];

  const oversizedResponse = await new Promise<number>((resolve, reject) => {
    const request = http.get({ hostname: parsedProxy.hostname, port: parsedProxy.port, path: 'http://public-example.com/oversized' }, result => {
      result.resume();
      result.once('end', () => resolve(result.statusCode ?? 0));
    });
    request.once('error', reject);
  });
  assert.equal(oversizedResponse, 413, 'oversized declared responses are rejected before forwarding their body');
  const streamedResponse = await new Promise<{ ended: boolean; bytes: number }>((resolve, reject) => {
    const request = http.get({ hostname: parsedProxy.hostname, port: parsedProxy.port, path: 'http://public-example.com/stream-oversized' }, result => {
      let bytes = 0;
      result.on('data', chunk => { bytes += Buffer.byteLength(chunk); });
      result.resume();
      result.once('end', () => resolve({ ended: true, bytes }));
      result.once('aborted', () => resolve({ ended: false, bytes }));
    });
    request.once('error', reject);
  });
  assert.equal(streamedResponse.ended, false, 'streaming response above the cap is cut off');
  assert.ok(streamedResponse.bytes <= 512, 'proxy never forwards more than the configured response limit');
  const dialCountAfterOversizedResponse = dialed.length;
  const oversizedRequest = await new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname: parsedProxy.hostname, port: parsedProxy.port, path: 'http://public-example.com/post', method: 'POST', headers: { 'content-length': '33' } }, result => {
      result.resume();
      result.once('end', () => resolve(result.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end('x'.repeat(33));
  });
  assert.equal(oversizedRequest, 413);
  assert.equal(dialed.length, dialCountAfterOversizedResponse, 'oversized uploads are rejected without an upstream connection');

  let releaseLookup!: (addresses: Array<{ address: string; family: number }>) => void;
  const closingProxy = new PinnedEgressProxy({
    resolveHost: () => new Promise(resolve => { releaseLookup = resolve; }),
    connect: (address, port) => { dialed.push({ address, port }); return net.connect({ host: '127.0.0.1', port: upstreamPort }); },
  });
  const closingUrl = new URL(await closingProxy.listen());
  const inFlight = new Promise<void>(resolve => {
    const request = http.get({ hostname: closingUrl.hostname, port: closingUrl.port, path: 'http://public-example.com/race' }, response => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', resolve);
  });
  while (!releaseLookup) await new Promise(resolve => setImmediate(resolve));
  const dialCountBeforeClose = dialed.length;
  const closeInProgress = closingProxy.close();
  releaseLookup([{ address: '93.184.216.34', family: 4 }]);
  await Promise.all([closeInProgress, inFlight]);
  assert.equal(dialed.length, dialCountBeforeClose, 'closing during DNS lookup must not open a new upstream socket');
} finally {
  await proxy.close();
  for (const socket of testSockets) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => tunnelUpstream.close(error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
}

const abortedTunnel = spawnSync(process.execPath, [
  '--import',
  'tsx',
  fileURLToPath(new URL('./pinned-egress-proxy-abort-child.ts', import.meta.url)),
], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });
assert.equal(abortedTunnel.status, 0, `aborted CONNECT tunnel crashed its child process:\n${abortedTunnel.stdout}\n${abortedTunnel.stderr}`);

console.log('pinned egress proxy tests passed');
