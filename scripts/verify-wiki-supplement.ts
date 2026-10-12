// Checks every key-article entry of backend/legal/wiki-supplement against the real law data: the article must exist
// and its official title must share wording with the entry's title, so a wrong article number cannot slip in.
// Usage: npm run verify:wiki   (spawns its own legal MCP process; does not touch the running backend)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../backend/src/config/env.js';
import { McpStdioClient } from '../backend/src/infrastructure/legal/mcp-stdio-client.js';
import { buildLegalMcpLaunchArgs } from '../backend/src/infrastructure/legal/mcp-launch.js';
import { LegalRetrievalService } from '../backend/src/infrastructure/legal/legal-retrieval-service.js';
import { OfficialLawArticleReader } from '../backend/src/infrastructure/legal/official-law-article-reader.js';
import { parseWikiCore } from '../backend/src/application/legal/legal-wiki-hints.js';

const folder = path.resolve('backend', 'legal', 'wiki-supplement');
const entries = readdirSync(folder)
  .filter(name => name.endsWith('.md'))
  .flatMap(name => parseWikiCore(readFileSync(path.join(folder, name), 'utf8')).map(hint => ({ file: name, ...hint })));

const squash = (value: string): string => value.replace(/\s+/g, '');
const words = (value: string): string[] => value.replace(/[()·,]/g, ' ').split(/\s+/).filter(word => word.length >= 2);
/** Bigrams of every word, so "구제신청" and "구제 신청" still overlap. */
const grams = (value: string): Set<string> => new Set(words(value).flatMap(word => Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))));

function legalEnv(): Record<string, string> {
  const entriesEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    USE_QDRANT: 'false',
    LEGAL_DATA_ROOT: env.legal.root,
    QDRANT_BACKEND: env.legal.vectorBackend,
    QDRANT_PATH: env.legal.qdrantPath,
    VECTOR_MEMMAP_PATH: env.legal.vectorMemmapPath,
    LEGAL_GRAPH_PATH: env.legal.graphPath,
    LEGAL_ONTOLOGY_PATH: env.legal.ontologyPath,
    OKF_BUNDLE_PATH: env.legal.okfPath
  };
  return Object.fromEntries(Object.entries(entriesEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
}

const client = new McpStdioClient({
  command: env.legal.python,
  args: buildLegalMcpLaunchArgs(env.legal.script, path.resolve('data', 'verify-wiki-mcp.log')),
  cwd: env.legal.runtimeRoot,
  env: legalEnv(),
  startupTimeoutMs: env.legal.startupTimeoutMs,
  requestTimeoutMs: env.legal.requestTimeoutMs,
  maxResponseCharacters: env.legal.maxResponseCharacters,
  restartBudget: 1,
  stderrTailCharacters: 4_000
});
const service = new LegalRetrievalService(client, {
  maxToolCalls: 4,
  maxRetrievalSteps: 4,
  maxQueryCharacters: env.legal.maxQueryCharacters,
  maxPrecedentCharacters: env.legal.retrieval.maxPrecedentCharacters,
  graphPath: env.legal.graphPath
}, new OfficialLawArticleReader());

let bad = 0;
try {
  for (const entry of entries) {
    const label = `${entry.lawName} ${entry.article} (${entry.title})`;
    try {
      const evidence = await service.retrieve([{ kind: 'law-article', lawName: entry.lawName, articleNumber: entry.article, title: entry.title }]);
      const source = evidence.sources.find(item => squash(item.lawName ?? '').includes(squash(entry.lawName)) && squash(`${item.articleNumber ?? ''}`) === squash(entry.article)) ?? evidence.sources[0];
      if (!source) {
        bad += 1;
        console.log(`MISSING  ${label}  [${entry.file}]`);
        continue;
      }
      const official = `${source.articleLabel ?? ''} ${source.title}`;
      const shared = [...grams(entry.title)].filter(gram => grams(official).has(gram)).length;
      const textShared = [...grams(entry.text)].filter(gram => grams(source.excerpt.slice(0, 600)).has(gram)).length;
      const ok = shared >= 2 || textShared >= 8;
      if (!ok) bad += 1;
      console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${label}  ←  official: ${official.trim().slice(0, 60)}${ok ? '' : `  [${entry.file}]`}`);
    } catch (error) {
      bad += 1;
      console.log(`ERROR    ${label}  ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`);
    }
  }
  console.log(`\n${entries.length - bad}/${entries.length} entries verified against the law data`);
} finally {
  await service.close();
}
process.exit(bad > 0 ? 1 : 0);
