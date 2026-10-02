import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLegalMcpLaunchArgs } from '../src/infrastructure/legal/mcp-launch.ts';

test('the legal MCP keeps its existing corpus entrypoint while redirecting logs outside testA', () => {
  const args = buildLegalMcpLaunchArgs(
    'C:/Users/spear/project/testA/rag_mcp_server.py',
    'C:/Users/spear/project/wwww/data/legal-rag-mcp.log'
  );
  assert.equal(args[0], '-c');
  assert.match(args[1] ?? '', /spec_from_file_location/);
  assert.match(args[1] ?? '', /module\.SERVER_LOG = pathlib\.Path\(log_path\)/);
  assert.equal(args[2], 'C:/Users/spear/project/testA/rag_mcp_server.py');
  assert.equal(args[3], 'C:/Users/spear/project/wwww/data/legal-rag-mcp.log');
});
