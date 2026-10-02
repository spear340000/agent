import { createInterface } from 'node:readline';

const mode = process.env.MCP_FIXTURE_MODE ?? process.argv[3] ?? 'ok';

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (mode === 'malformed') {
  process.stdin.on('data', () => process.stdout.write('not json at all\n'));
} else if (mode === 'hang') {
  process.stdin.on('data', () => undefined);
} else {
  const reader = createInterface({ input: process.stdin });
  let toolCalls = 0;
  reader.on('line', line => {
    let request: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      });
      return;
    }
    if (request.method !== 'tools/call') return;
    toolCalls += 1;
    if (mode === 'crash-after-first' && toolCalls === 2) {
      process.exit(9);
      return;
    }
    const name = request.params?.name ?? '';
    const args = request.params?.arguments ?? {};
    if (name === 'slow') {
      setTimeout(() => send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '늦은 응답' }] } }), 5_000);
      return;
    }
    if (name === 'fail') {
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'Error: 실패' }], isError: true } });
      return;
    }
    const text =
      name === 'echo'
        ? `Search: ${String(args.query ?? '')}\nResults: 1\n\n[1] ${String(args.query ?? '')}\n\n본문`
        : name === 'flood'
          ? 'x'.repeat(200_000)
          : '응답';
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }] } });
  });
}

process.on('SIGTERM', () => process.exit(0));
