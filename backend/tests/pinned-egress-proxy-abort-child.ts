import net from 'node:net';
import { PinnedEgressProxy } from '../src/tools/pinned-egress-proxy.js';

const upstreamServer = net.createServer(socket => {
  socket.on('error', () => undefined);
  const send = (): void => {
    if (socket.destroyed) return;
    socket.write(Buffer.alloc(64 * 1024), () => setImmediate(send));
  };
  send();
});
const upstreamSockets = new Set<net.Socket>();
upstreamServer.on('connection', socket => {
  upstreamSockets.add(socket);
  socket.once('close', () => upstreamSockets.delete(socket));
});
await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;
const proxy = new PinnedEgressProxy({
  resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
});

try {
  const proxyUrl = new URL(await proxy.listen());
  const client = net.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  client.on('error', () => undefined);
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CONNECT response timed out')), 2_000);
    client.on('data', chunk => {
      const response = chunk.toString('latin1');
      if (!response.includes('200 Connection Established')) return;
      clearTimeout(timer);
      client.destroy();
      resolve();
    });
    client.once('error', reject);
    client.once('connect', () => client.write('CONNECT public-example.com:443 HTTP/1.1\r\nHost: public-example.com:443\r\n\r\n'));
  });
  await connected;
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('aborted CONNECT tunnel contained');
} finally {
  await proxy.close();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise<void>(resolve => upstreamServer.close(() => resolve()));
}
