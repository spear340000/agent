import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../src/tools/public-url.ts';
import { browserAction, computerAction } from '../src/api/contracts.ts';
import { BrowserUseService, secureChromiumLaunchOptions } from '../src/tools/browser-use.ts';
import { PinnedEgressProxy } from '../src/tools/pinned-egress-proxy.ts';

type ResolvedAddress = { address: string; family: number };
type TestResolver = (hostname: string) => Promise<ResolvedAddress[]>;
const publicResolver: TestResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const blockedUrls = [
  'http://localhost/', 'http://service.local/', 'http://192.168.1.1/',
  'http://127.0.0.1/', 'http://10.0.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/',
  'http://172.16.0.1/', 'http://192.0.2.1/', 'http://198.18.0.1/', 'http://198.51.100.1/',
  'http://203.0.113.1/', 'http://224.0.0.1/', 'http://240.0.0.1/',
  'http://[::]/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[ff02::1]/',
  'http://[100::1]/', 'http://[2001:20::1]/', 'http://[2001:db8::1]/', 'http://[2002::1]/',
  'http://[3fff::1]/', 'http://[64:ff9b::c0a8:1]/', 'http://[::ffff:192.168.1.1]/',
  'ftp://93.184.216.34/', 'http://user:pass@public.example/',
];

for (const value of blockedUrls) await assert.rejects(assertPublicHttpUrl(value, publicResolver), { message: /private|only public/i }, value);
await assertPublicHttpUrl('https://public.example.com/path', publicResolver);
const mixedResolver: TestResolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }];
await assert.rejects(assertPublicHttpUrl('https://mixed.example.com/', mixedResolver), /private or local/);
const brokenResolver: TestResolver = async () => { throw new Error('DNS down'); };
await assert.rejects(assertPublicHttpUrl('https://unresolved.example.com/', brokenResolver), /could not be resolved/);
assert.throws(() => browserAction({ kind: 'navigate', url: `https://example.com/${'a'.repeat(2_050)}` }), /url.*2048/);
assert.throws(() => browserAction({ kind: 'type', selector: 'input', text: 'x'.repeat(100_001) }), /100000 characters/);
assert.throws(() => computerAction({ action: { kind: 'type', text: 'x'.repeat(10_001) } }), /10000 characters/);
await assert.rejects(assertPublicHttpUrl('http://93.184.216.34:444/'), /ports 80 and 443/);
const chromiumOptions = secureChromiumLaunchOptions('chrome.exe', 'http://127.0.0.1:45678');
assert.equal(chromiumOptions.proxy.bypass, '<-loopback>');
assert.ok(chromiumOptions.args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'));

let renderedPdfOptions: Record<string, unknown> | undefined;
const pdfPage = {
  setContent: async () => undefined,
  evaluate: async () => undefined,
  title: async () => 'Korean legal report',
  pdf: async (options: Record<string, unknown>) => {
    renderedPdfOptions = options;
    return Buffer.from('%PDF-1.4');
  },
};
const pdfService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: { listen: async () => 'http://127.0.0.1:45678', close: async () => undefined } as never,
  launch: async () => ({ newPage: async () => pdfPage, close: async () => undefined } as never),
});
await pdfService.renderPdf('<html><body><h1>Report</h1></body></html>');
const pdfHeader = String(renderedPdfOptions?.headerTemplate);
const pdfFooter = String(renderedPdfOptions?.footerTemplate);
assert.match(pdfHeader, /font-family:Malgun Gothic,Arial,sans-serif;font-size:9px/);
assert.match(pdfHeader, /<table style="width:calc\(100% - 36mm\);margin:0 18mm;border-collapse:collapse/);
assert.match(pdfHeader, /<td style="width:50%;border-bottom:1px solid/);
assert.match(pdfHeader, /padding:0 0 5px/);
assert.match(pdfFooter, /<table style="width:calc\(100% - 36mm\);margin:0 18mm;border-collapse:collapse/);
assert.match(pdfFooter, /<td style="width:50%;border-top:1px solid/);
assert.match(pdfFooter, /<span class="pageNumber"><\/span> \/ <span class="totalPages"><\/span>/);
assert.match(pdfFooter, /font-family:Malgun Gothic,Arial,sans-serif;font-size:9px/);
assert.match(pdfFooter, /padding:5px 0 0/);
await pdfService.closeAll();

let screenshotCaptured = false;
const screenshotPage = {
  context: () => ({}), route: async () => undefined, url: () => 'https://public.example/', title: async () => 'public',
  evaluate: async () => ({ width: 20, height: 20 }),
  screenshot: async () => { screenshotCaptured = true; return Buffer.from('png'); },
};
const screenshotService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: { listen: async () => 'http://127.0.0.1:45678', close: async () => undefined } as never,
  maxScreenshotPixels: 100,
  maxScreenshotBytes: 1_024,
  launch: async () => ({ newPage: async () => screenshotPage, close: async () => undefined } as never),
});
const screenshotSession = await screenshotService.create();
await assert.rejects(screenshotService.perform(screenshotSession.sessionId, { kind: 'screenshot' }), /screenshot exceeds the configured pixel limit/i);
assert.equal(screenshotCaptured, false, 'oversized screenshots must be rejected before image capture');
await screenshotService.closeAll();

let routeHandler: ((route: never) => Promise<void>) | undefined;
let redirectedRequestContinued = false;
let redirectedRequestAborted = false;
const redirectPage = { context: () => ({}), url: () => 'about:blank', title: async () => '', route: async (_pattern: string, handler: (route: never) => Promise<void>) => { routeHandler = handler; } };
const redirectService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: { listen: async () => 'http://127.0.0.1:45678', close: async () => undefined } as never,
  launch: async () => ({ newPage: async () => redirectPage, close: async () => undefined } as never),
});
const redirectSession = await redirectService.create();
assert.ok(routeHandler);
await routeHandler!({
  request: () => ({ url: () => 'http://127.0.0.1/private-redirect-target' }),
  continue: async () => { redirectedRequestContinued = true; },
  abort: async () => { redirectedRequestAborted = true; },
} as never);
assert.equal(redirectedRequestAborted, true, 'redirected private targets must be blocked by the page policy');
assert.equal(redirectedRequestContinued, false);
await redirectService.close(redirectSession.sessionId);
await redirectService.closeAll();

let launches = 0;
const launchReleases: Array<(browser: never) => void> = [];
let signalTwoLaunches!: () => void;
const twoLaunches = new Promise<void>(resolve => { signalTwoLaunches = resolve; });
let signalThreeLaunches!: () => void;
const threeLaunches = new Promise<void>(resolve => { signalThreeLaunches = resolve; });
const proxyUrls: string[] = [];
const mockPage = { context: () => ({}), route: async () => undefined, url: () => 'about:blank', title: async () => '' };
const service = new BrowserUseService({
  maxSessions: 2,
  findExecutable: () => 'fake-browser',
  launch: async (_executable, proxyUrl) => { launches++; proxyUrls.push(proxyUrl); if (launches === 2) signalTwoLaunches(); if (launches === 3) signalThreeLaunches(); return new Promise(resolve => launchReleases.push(resolve as (browser: never) => void)); },
});
const firstSession = service.create();
const secondSession = service.create();
await twoLaunches;
assert.equal(launches, 2);
assert.ok(proxyUrls.every(url => url.startsWith('http://127.0.0.1:')));
await assert.rejects(service.create(), /maximum browser sessions/);
const fakeBrowser = { newPage: async () => mockPage, close: async () => undefined } as never;
launchReleases.splice(0).forEach(release => release(fakeBrowser));
const created = await Promise.all([firstSession, secondSession]);
await service.close(created[0]!.sessionId);
const thirdSession = service.create();
await threeLaunches;
assert.equal(launches, 3);
launchReleases.shift()!(fakeBrowser);
const third = await thirdSession;
await service.close(third.sessionId);
await service.closeAll();

let releaseShutdownLaunch!: (browser: never) => void;
let shutdownBrowserClosed = 0;
let signalShutdownLaunch!: () => void;
const shutdownLaunchStarted = new Promise<void>(resolve => { signalShutdownLaunch = resolve; });
const shutdownService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  launch: async () => new Promise(resolve => { signalShutdownLaunch(); releaseShutdownLaunch = resolve as (browser: never) => void; }),
});
const pendingSession = shutdownService.create();
await shutdownLaunchStarted;
const closing = shutdownService.closeAll();
releaseShutdownLaunch({ newPage: async () => mockPage, close: async () => { shutdownBrowserClosed++; } } as never);
await assert.rejects(pendingSession, /shutting down/);
await closing;
assert.equal(shutdownBrowserClosed, 1);
await assert.rejects(shutdownService.create(), /shutting down/);

const cleanupProxy = new PinnedEgressProxy();
const closeFailureService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: cleanupProxy,
  launch: async () => ({ newPage: async () => mockPage, close: async () => { throw new Error('browser close failed'); } } as never),
});
await closeFailureService.create();
await assert.rejects(closeFailureService.closeAll(), /browser close failed/);
await assert.rejects(cleanupProxy.listen(), /closing/);

const directNavigation: string[] = [];
const pageText = 'Verified public page text. '.repeat(12);
const contentLocator = { first() { return this; }, async innerText() { return pageText; } };
const shortContentLocator = { first() { return this; }, async innerText() { return '기사 제목 기자명 2024-08-14'; } };
const directPage = {
  context: () => ({}),
  route: async () => undefined,
  url: () => directNavigation.at(-1) ?? 'about:blank',
  title: async () => 'Public source',
  goto: async (url: string) => { directNavigation.push(url); },
  locator: () => directNavigation.at(-1)?.endsWith('/short') ? shortContentLocator : contentLocator,
};
const directSourceService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: { listen: async () => 'http://127.0.0.1:45678', close: async () => undefined } as never,
  launch: async () => ({ newPage: async () => directPage, close: async () => undefined } as never),
});
const directSources = await directSourceService.visitMany(['http://1.1.1.1/report', 'http://1.1.1.1/short', 'http://127.0.0.1/private']);
assert.equal(directSources[0]?.retrievalStatus, 'retrieved');
assert.equal(directSources[0]?.content, pageText.trim());
assert.equal(directSources[1]?.retrievalStatus, 'unavailable', 'a title/byline/date shell is not treated as readable article evidence');
assert.match(directSources[1]?.retrievalError ?? '', /본문 텍스트/);
assert.equal(directSources[2]?.retrievalStatus, 'unavailable');
assert.deepEqual(directNavigation, ['http://1.1.1.1/report', 'http://1.1.1.1/short'], 'private URL inputs must never reach the browser');
await directSourceService.closeAll();

const searchNavigation: string[] = [];
let delegatedQueries: string[] = [];
const searchPageText = 'Verified search-page text. '.repeat(10);
const searchContentLocator = { first() { return this; }, async innerText() { return searchPageText; } };
const searchPage = {
  context: () => ({}),
  route: async () => undefined,
  url: () => searchNavigation.at(-1) ?? 'about:blank',
  title: async () => 'Verified page',
  goto: async (url: string) => { searchNavigation.push(url); },
  locator: (selector: string) => selector === '.result'
    ? { async evaluateAll() { return []; } }
    : searchContentLocator,
};
const searchService = new BrowserUseService({
  maxSessions: 1,
  findExecutable: () => 'fake-browser',
  proxy: { listen: async () => 'http://127.0.0.1:45678', close: async () => undefined } as never,
  launch: async () => ({ newPage: async () => searchPage, close: async () => undefined } as never),
  searchProvider: {
    searchMany: async (queries: string[]) => {
      delegatedQueries = queries;
      return [{ title: 'SearXNG result', url: 'https://93.184.216.34/fact', snippet: 'Search snippet' }];
    },
  } as never,
});
const searchSources = await searchService.searchMany(['a real query'], 3);
assert.deepEqual(delegatedQueries, ['a real query']);
assert.deepEqual(searchNavigation, ['https://93.184.216.34/fact']);
assert.equal(searchSources[0]?.title, 'Verified page');
assert.equal(searchSources[0]?.snippet, 'Search snippet');
assert.equal(searchSources[0]?.content, searchPageText.trim());
assert.equal(searchSources[0]?.retrievalStatus, 'retrieved');
await searchService.closeAll();

console.log('browser policy tests passed');
