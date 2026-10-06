import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "playwright-core";
import type { WebSearchProvider } from "../domain/web-search.js";
import { AppError } from "../shared/app-error.js";
import { env } from "../config/env.js";
import { assertPublicHttpUrl } from "./public-url.js";
import { PinnedEgressProxy } from "./pinned-egress-proxy.js";

export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "extractText"; selector?: string }
  | { kind: "screenshot" };
export type BrowserResult = {
  sessionId: string;
  url: string;
  title: string;
  text?: string;
  screenshotBase64?: string;
};
export type WebSource = {
  title: string;
  url: string;
  snippet: string;
  content: string;
  retrievedAt: string;
  retrievalStatus: "retrieved" | "unavailable";
  retrievalError?: string;
};
type BrowserSession = { browser: Browser; page: Page };
export type BrowserUseOptions = {
  maxSessions?: number;
  findExecutable?: () => string | undefined;
  launch?: (executablePath: string, proxyServer: string) => Promise<Browser>;
  proxy?: PinnedEgressProxy;
  searchProvider?: WebSearchProvider;
  maxScreenshotPixels?: number;
  maxScreenshotBytes?: number;
};

const MIN_SUBSTANTIVE_PAGE_TEXT = 160;

async function extractVisiblePageText(page: Page): Promise<string> {
  let best = "";
  for (const selector of ["article", "main", '[role="main"]', "body"]) {
    try {
      const text = (
        await page.locator(selector).first().innerText({ timeout: 5_000 })
      ).trim();
      if (text.length > best.length) best = text;
      if (best.length >= MIN_SUBSTANTIVE_PAGE_TEXT) break;
    } catch {
      // Try the next broader content container; a missing <main> is common.
    }
  }
  return best.slice(0, 12_000);
}

function chromePath(
  configured = env.browserExecutablePath,
): string | undefined {
  const candidates = [
    configured,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[];
  return candidates.find(existsSync);
}

export function secureChromiumLaunchOptions(
  executablePath: string,
  proxyServer: string,
) {
  return {
    executablePath,
    headless: true,
    proxy: { server: proxyServer, bypass: "<-loopback>" },
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  };
}

export class BrowserUseService {
  private sessions = new Map<string, BrowserSession>();
  private activeBrowsers = 0;
  private closing = false;
  private operations = new Set<Promise<void>>();
  private closePromise: Promise<void> | undefined;
  private readonly maxSessions: number;
  private readonly findExecutable: () => string | undefined;
  private readonly launch: (
    executablePath: string,
    proxyServer: string,
  ) => Promise<Browser>;
  private readonly proxy: PinnedEgressProxy;
  private readonly searchProvider: WebSearchProvider | undefined;
  private readonly maxScreenshotPixels: number;
  private readonly maxScreenshotBytes: number;

  constructor(options: BrowserUseOptions = {}) {
    this.maxSessions = options.maxSessions ?? env.maxBrowserSessions;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("maxBrowserSessions must be a positive integer");
    this.findExecutable = options.findExecutable ?? (() => chromePath());
    this.proxy = options.proxy ?? new PinnedEgressProxy();
    this.searchProvider = options.searchProvider;
    this.maxScreenshotPixels = options.maxScreenshotPixels ?? 16_000_000;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? 8 * 1024 * 1024;
    for (const [name, value] of Object.entries({
      maxScreenshotPixels: this.maxScreenshotPixels,
      maxScreenshotBytes: this.maxScreenshotBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    }
    this.launch =
      options.launch ??
      (async (executablePath, proxyServer) => {
        const { chromium } = await import("playwright-core");
        return chromium.launch(
          secureChromiumLaunchOptions(executablePath, proxyServer),
        );
      });
  }

  isAvailable(): boolean {
    return Boolean(this.findExecutable());
  }

  create(url?: string): Promise<BrowserResult> {
    return this.track(() => this.createSession(url));
  }

  private async createSession(url?: string): Promise<BrowserResult> {
    if (this.activeBrowsers >= this.maxSessions)
      throw new AppError(429, "maximum browser sessions reached");
    const executablePath = this.findExecutable();
    if (!executablePath)
      throw new Error(
        "Chrome executable not found. Set BROWSER_EXECUTABLE_PATH.",
      );
    this.activeBrowsers++;
    let browser: Browser | undefined;
    const sessionId = `browser_${randomUUID()}`;
    try {
      browser = await this.launch(executablePath, await this.proxy.listen());
      if (this.closing) throw new Error("browser service is shutting down");
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1024 },
      });
      await this.guardPage(page);
      if (this.closing) throw new Error("browser service is shutting down");
      this.sessions.set(sessionId, { browser, page });
      if (url) return await this.perform(sessionId, { kind: "navigate", url });
      return { sessionId, url: page.url(), title: await page.title() };
    } catch (error) {
      this.sessions.delete(sessionId);
      this.activeBrowsers--;
      await browser?.close().catch(() => undefined);
      throw error;
    }
  }

  async search(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<WebSource[]> {
    return this.searchMany([query], limit, signal);
  }

  searchMany(
    queries: string[],
    limit = 5,
    signal?: AbortSignal,
  ): Promise<WebSource[]> {
    return this.track(() => this.runSearch(queries, limit, signal));
  }

  visitMany(urls: string[], signal?: AbortSignal): Promise<WebSource[]> {
    return this.track(() => this.runVisitMany(urls, signal));
  }

  renderPdf(html: string): Promise<Uint8Array> {
    return this.track(async () => {
      if (html.length > 2_000_000)
        throw new AppError(413, "PDF source document is too large");
      if (this.activeBrowsers >= this.maxSessions)
        throw new AppError(429, "maximum browser sessions reached");
      const executablePath = this.findExecutable();
      if (!executablePath)
        throw new Error(
          "Chrome executable not found. Set BROWSER_EXECUTABLE_PATH.",
        );
      this.activeBrowsers += 1;
      let browser: Browser | undefined;
      try {
        browser = await this.launch(executablePath, await this.proxy.listen());
        if (this.closing) throw new Error("browser service is shutting down");
        const page = await browser.newPage({
          viewport: { width: 794, height: 1123 },
        });
        await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const title = (await page.title()).replace(
          /[&<>"']/gu,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character]!,
        );
        return Buffer.from(
          await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: `<table style="width:calc(100% - 36mm);margin:0 18mm;border-collapse:collapse;font-family:Malgun Gothic,Arial,sans-serif;font-size:9px;color:#68756c"><tr><td style="width:50%;border-bottom:1px solid #e1e6e1;padding:0 0 5px;font-weight:700;letter-spacing:.08em;color:#365c4a">WORKFOLIO</td><td style="width:50%;max-width:50%;border-bottom:1px solid #e1e6e1;padding:0 0 5px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</td></tr></table>`,
            footerTemplate: `<table style="width:calc(100% - 36mm);margin:0 18mm;border-collapse:collapse;font-family:Malgun Gothic,Arial,sans-serif;font-size:9px;color:#68756c"><tr><td style="width:50%;border-top:1px solid #e1e6e1;padding:5px 0 0;text-align:left">문서 내보내기</td><td style="width:50%;border-top:1px solid #e1e6e1;padding:5px 0 0;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></td></tr></table>`,
            margin: {
              top: "19mm",
              right: "18mm",
              bottom: "18mm",
              left: "18mm",
            },
          }),
        );
      } finally {
        this.activeBrowsers -= 1;
        await browser?.close().catch(() => undefined);
      }
    });
  }

  private async runVisitMany(
    urls: string[],
    signal?: AbortSignal,
  ): Promise<WebSource[]> {
    if (urls.length === 0) return [];
    if (this.activeBrowsers >= this.maxSessions)
      throw new AppError(429, "maximum browser sessions reached");
    const executablePath = this.findExecutable();
    if (!executablePath)
      throw new Error(
        "Chrome executable not found. Set BROWSER_EXECUTABLE_PATH.",
      );
    this.activeBrowsers++;
    let browser: Browser | undefined;
    let abortBrowser: (() => void) | undefined;
    try {
      browser = await this.launch(executablePath, await this.proxy.listen());
      if (this.closing) throw new Error("browser service is shutting down");
      abortBrowser = (): void => {
        void browser?.close();
      };
      if (signal?.aborted) throw new Error("web research cancelled");
      signal?.addEventListener("abort", abortBrowser, { once: true });
      const page = await browser.newPage();
      await this.guardPage(page);
      const sources: WebSource[] = [];
      for (const value of urls.slice(0, 6)) {
        if (signal?.aborted) throw new Error("web research cancelled");
        try {
          const url = await assertPublicHttpUrl(value);
          await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          const content = await extractVisiblePageText(page);
          const readable = content.length >= MIN_SUBSTANTIVE_PAGE_TEXT;
          sources.push({
            title: (await page.title()) || url.hostname,
            url: page.url(),
            snippet: readable ? content.slice(0, 500) : "",
            content: readable ? content : "",
            retrievedAt: new Date().toISOString(),
            retrievalStatus: readable ? "retrieved" : "unavailable",
            ...(!readable
              ? {
                  retrievalError:
                    "페이지 본문 텍스트를 충분히 확인하지 못했습니다.",
                }
              : {}),
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          sources.push({
            title: value,
            url: value,
            snippet: "",
            content: "",
            retrievedAt: new Date().toISOString(),
            retrievalStatus: "unavailable",
            retrievalError: "페이지를 열거나 본문을 읽지 못했습니다.",
          });
        }
      }
      return sources;
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      await browser?.close();
      this.activeBrowsers--;
    }
  }

  private async runSearch(
    queries: string[],
    limit = 5,
    signal?: AbortSignal,
  ): Promise<WebSource[]> {
    if (!this.searchProvider)
      throw new Error("SearXNG search provider is not configured");
    if (signal?.aborted) throw new Error("web research cancelled");
    const results = (
      await this.searchProvider.searchMany(queries.slice(0, 3), limit, signal)
    ).slice(0, 6);
    if (!results.length) return [];
    const pages = await this.runVisitMany(
      results.map((result) => result.url),
      signal,
    );
    return results.map((result, index) => {
      const page = pages[index];
      if (!page)
        return {
          ...result,
          content: "",
          retrievedAt: new Date().toISOString(),
          retrievalStatus: "unavailable",
        };
      return {
        ...page,
        title:
          page.retrievalStatus === "retrieved" && page.title
            ? page.title
            : result.title,
        snippet: result.snippet || page.snippet,
      };
    });
  }

  async perform(
    sessionId: string,
    action: BrowserAction,
  ): Promise<BrowserResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("browser session not found");
    const { page } = session;
    if (action.kind === "navigate") {
      const url = await assertPublicHttpUrl(action.url);
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    if (action.kind === "click")
      await page.locator(action.selector).click({ timeout: 15_000 });
    if (action.kind === "type")
      await page
        .locator(action.selector)
        .fill(action.text, { timeout: 15_000 });
    const result: BrowserResult = {
      sessionId,
      url: page.url(),
      title: await page.title(),
    };
    if (action.kind === "extractText")
      result.text = await page
        .locator(action.selector ?? "body")
        .innerText({ timeout: 15_000 });
    if (action.kind === "screenshot") {
      const dimensions = await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ),
      }));
      if (dimensions.width * dimensions.height > this.maxScreenshotPixels)
        throw new AppError(
          413,
          "screenshot exceeds the configured pixel limit",
        );
      const screenshot = await page.screenshot({
        type: "png",
        fullPage: true,
        animations: "disabled",
        timeout: 15_000,
      });
      if (screenshot.byteLength > this.maxScreenshotBytes)
        throw new AppError(413, "screenshot exceeds the configured byte limit");
      result.screenshotBase64 = screenshot.toString("base64");
    }
    return result;
  }

  private async guardPage(page: Page): Promise<void> {
    // HTTP, HTTPS CONNECT, and WebSocket traffic are enforced at the pinned egress proxy.
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (/^(?:data:|blob:|about:)/i.test(requestUrl)) {
        await route.continue();
        return;
      }
      try {
        await assertPublicHttpUrl(requestUrl);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.activeBrowsers--;
    await session.browser.close();
  }
  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.all([...this.operations]);
      const results = await Promise.allSettled(
        [...this.sessions.keys()].map((id) => this.close(id)),
      );
      let failure: unknown;
      try {
        await this.proxy.close();
      } catch (error) {
        failure = error;
      }
      failure ??= results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )?.reason;
      if (failure) throw failure;
    })();
    return this.closePromise;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("browser service is shutting down"));
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.operations.add(completed);
    return operation().finally(() => {
      this.operations.delete(completed);
      finish();
    });
  }
}
