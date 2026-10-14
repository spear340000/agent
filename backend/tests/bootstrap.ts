import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

// A request that outlives its test fails later as an uncaught "fetch failed" with no URL, which the test runner reports
// without a stack. Name the URL and the underlying cause at the point of failure, so such a failure can be traced.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    return await nativeFetch(input, init);
  } catch (error) {
    const url = input instanceof Request ? input.url : String(input);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const code = cause && 'code' in cause ? ` (${String((cause as { code?: unknown }).code)})` : '';
    console.error(`[fetch failed] ${init?.method ?? 'GET'} ${url} · ${error instanceof Error ? error.message : String(error)}${cause ? ` · cause: ${cause.message}${code}` : ''}`);
    throw error;
  }
}) as typeof fetch;

process.on('uncaughtException', error => console.error('[uncaught]', error.stack ?? error));
process.on('unhandledRejection', reason => console.error('[unhandled rejection]', reason instanceof Error ? reason.stack ?? reason.message : reason));

const target = process.argv[2];
await import(target ? pathToFileURL(path.resolve(target)).href : './run.ts');
