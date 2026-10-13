import type http from "node:http";
import { TaskService } from "../application/task-service.js";
import { ComputerControlService } from "../application/computer-control-service.js";
import { badRequest, notFound, unavailable } from "../shared/app-error.js";
import { readJson, sendJson } from "./http.js";
import {
  browserAction,
  browserUrl,
  computerAction,
  taskInput,
  taskRevisionInput,
  asString,
  spreadsheetInspectInput,
  spreadsheetOperations,
} from "./contracts.js";
import { BrowserUseService } from "../tools/browser-use.js";
import { FileService } from "../application/file-service.js";
import {
  SpreadsheetService,
  type SpreadsheetOperation,
} from "../application/spreadsheet-service.js";
import { DocumentService } from "../application/document-service.js";
import { DocumentContentService } from "../application/document-content-service.js";
import { PdfService } from "../application/pdf-service.js";
import {
  RedactionService,
  type RedactionRule,
} from "../application/redaction-service.js";
import {
  DocumentAiService,
  type AiDocumentOperation,
} from "../application/document-ai-service.js";
import type { TaskEventBus } from "../application/task-event-bus.js";
import { env } from "../config/env.js";
import { isAllowedOrigin } from "./origin-policy.js";
import type { ApiAuthenticator } from "./authentication.js";
import type { CapabilityService } from "../application/capability-service.js";
import type { LegalRetrievalService } from "../infrastructure/legal/legal-retrieval-service.js";
import { assignCitationIds } from "../infrastructure/legal/legal-retrieval-service.js";
import type { LegalCatalogService } from "../application/legal/legal-catalog-service.js";
import type { LegalWikiService } from "../application/legal/legal-wiki-service.js";

const responseOrigin = (res: http.ServerResponse): string | undefined => {
  const value = res.getHeader("access-control-allow-origin");
  return typeof value === "string" ? value : undefined;
};

function readLegalState(capabilities: CapabilityService): string {
  try {
    return capabilities.legalCapability().state;
  } catch {
    return "unknown";
  }
}

export class ApiRouter {
  constructor(
    private readonly deps: {
      tasks: TaskService;
      browser: BrowserUseService;
      computer: ComputerControlService;
      capabilities: CapabilityService;
      legalRetrieval?: LegalRetrievalService;
      legalCatalog?: LegalCatalogService;
      legalWiki?: LegalWikiService;
      files: FileService;
      spreadsheets: SpreadsheetService;
      documents: DocumentService;
      content: DocumentContentService;
      pdfs: PdfService;
      redaction: RedactionService;
      documentAi: DocumentAiService;
      eventBus: TaskEventBus;
      authenticator: ApiAuthenticator;
    },
  ) {}
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (!isAllowedOrigin(req.headers.origin, env.frontendOrigins))
      return sendJson(res, 403, { error: "origin is not allowed" });
    if (req.headers.origin) {
      res.setHeader("access-control-allow-origin", req.headers.origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (url.pathname === "/health")
      return sendJson(res, 200, {
        ok: true,
        service: "typescript-agent-runtime",
        browserUse: this.deps.browser.isAvailable(),
        computerUse: this.deps.computer.isAvailable(),
        legalRetrieval: readLegalState(this.deps.capabilities),
      });
    if (url.pathname.startsWith("/api/"))
      this.deps.authenticator.requireAuthorized(req.headers.authorization);
    if (req.method === "GET" && url.pathname === "/api/tasks")
      return sendJson(res, 200, { items: this.deps.tasks.list() });
    if (req.method === "GET" && url.pathname === "/api/capabilities")
      return sendJson(res, 200, await this.deps.capabilities.getCapabilities());
    if (req.method === "GET" && url.pathname === "/api/legal/library")
      return this.searchLegalLibrary(url, res);
    if (req.method === "GET" && url.pathname === "/api/legal/precedent")
      return this.readLegalPrecedent(url, res);
    if (req.method === "GET" && url.pathname === "/api/legal/tools") {
      if (!this.deps.legalRetrieval)
        throw unavailable("법률 도구 목록을 확인할 수 없습니다.");
      return sendJson(res, 200, {
        items: await this.deps.legalRetrieval.listTools(),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/legal/catalog") {
      if (!this.deps.legalCatalog)
        throw unavailable("OKF 카탈로그가 설정되지 않았습니다.");
      return sendJson(res, 200, { items: await this.deps.legalCatalog.list() });
    }
    if (req.method === "GET" && url.pathname === "/api/legal/wiki") {
      if (!this.deps.legalWiki)
        throw unavailable("읽기 전용 법률 Wiki가 설정되지 않았습니다.");
      return sendJson(res, 200, { items: await this.deps.legalWiki.list() });
    }
    if (req.method === "GET" && url.pathname === "/api/legal/wiki/page") {
      if (!this.deps.legalWiki)
        throw unavailable("읽기 전용 법률 Wiki가 설정되지 않았습니다.");
      const name = url.searchParams.get("name");
      if (name === null) throw badRequest("name is required");
      return sendJson(
        res,
        200,
        await this.deps.legalWiki.readPage(
          name,
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 12_000),
        ),
      );
    }
    if (req.method === "POST" && url.pathname === "/api/tasks")
      return this.createTask(req, res);
    if (
      parts[0] === "api" &&
      parts[1] === "tasks" &&
      parts[2] &&
      parts[3] === "events" &&
      req.method === "GET"
    )
      return this.streamTaskEvents(req, res, parts[2]);
    if (parts[0] === "api" && parts[1] === "tasks" && parts[2])
      return this.taskRoute(req, res, parts[2], parts[3]);
    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "artifacts" &&
      parts[2]
    )
      return sendJson(res, 200, this.deps.tasks.getArtifact(parts[2]));
    if (req.method === "POST" && url.pathname === "/api/browser/sessions")
      return this.createBrowserSession(req, res);
    if (
      parts[0] === "api" &&
      parts[1] === "browser" &&
      parts[2] === "sessions" &&
      parts[3]
    )
      return this.browserRoute(req, res, parts[3], parts[4]);
    if (req.method === "POST" && url.pathname === "/api/computer/actions")
      return this.performComputerAction(req, res);
    if (req.method === "POST" && url.pathname === "/api/search")
      return this.searchWeb(req, res);
    if (req.method === "POST" && url.pathname === "/api/files")
      return this.uploadFile(req, res);
    if (req.method === "GET" && url.pathname === "/api/files")
      return sendJson(
        res,
        200,
        await this.deps.files.list({
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          search: url.searchParams.get("search") ?? undefined,
        }),
      );
    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "files" &&
      parts[2] &&
      parts[3] === "content"
    )
      return this.getFileContent(res, parts[2]);
    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "files" &&
      parts[2]
    )
      return this.getFile(res, parts[2]);
    if (req.method === "POST" && url.pathname === "/api/spreadsheets/edit")
      return this.editSpreadsheet(req, res);
    if (req.method === "POST" && url.pathname === "/api/spreadsheets/create")
      return this.createSpreadsheet(req, res);
    if (req.method === "POST" && url.pathname === "/api/spreadsheets/inspect")
      return this.inspectSpreadsheet(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/create")
      return this.createDocument(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/markdown")
      return this.createMarkdown(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/export")
      return this.exportMarkdown(req, res);
    if (
      req.method === "POST" &&
      url.pathname === "/api/documents/template-fill"
    )
      return this.fillDocumentTemplate(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/extract")
      return this.extractDocument(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/compare")
      return this.compareDocuments(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/redact")
      return this.redactDocument(req, res);
    if (req.method === "POST" && url.pathname === "/api/pdfs/merge")
      return this.mergePdfs(req, res);
    if (req.method === "POST" && url.pathname === "/api/pdfs/thumbnails") {
      const body = await readJson(req);
      if (
        !Array.isArray(body.pageNumbers) ||
        !body.pageNumbers.every((pageNumber) => typeof pageNumber === "number")
      )
        throw badRequest("pageNumbers must be a number array");
      return sendJson(
        res,
        200,
        await this.deps.pdfs.renderThumbnails({
          fileId: asString(body.fileId, "fileId", true)!,
          pageNumbers: body.pageNumbers as number[],
        }),
      );
    }
    if (req.method === "POST" && url.pathname === "/api/pdfs/inspect") {
      const body = await readJson(req);
      return sendJson(
        res,
        200,
        await this.deps.pdfs.inspect(asString(body.fileId, "fileId", true)!),
      );
    }
    if (req.method === "POST" && url.pathname === "/api/pdfs/split")
      return this.splitPdf(req, res);
    if (req.method === "POST" && url.pathname === "/api/pdfs/edit")
      return this.editPdf(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/replace-text")
      return this.replaceDocumentText(req, res);
    if (req.method === "POST" && url.pathname === "/api/documents/ai")
      return this.runDocumentAi(req, res);
    throw notFound("route not found");
  }
  private async createTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const task = await this.deps.tasks.create(taskInput(await readJson(req)));
    sendJson(res, 202, { task });
  }
  private streamTaskEvents(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
  ): void {
    this.deps.tasks.getDetails(taskId);
    const origin = responseOrigin(res);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...(origin ? { "access-control-allow-origin": origin } : {}),
    });
    res.write("retry: 3000\n");
    const lastEventId = Number(req.headers["last-event-id"] ?? 0);
    let lastId =
      Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;
    const write = (event: import("../domain/task.js").TaskEvent): void => {
      if (event.id <= lastId || res.destroyed) return;
      lastId = event.id;
      res.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    const unsubscribe = this.deps.eventBus.subscribe(taskId, write);
    for (const event of this.deps.tasks.getDetails(taskId).events) write(event);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 20_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
  private async taskRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    action?: string,
  ) {
    if (req.method === "GET" && !action)
      return sendJson(res, 200, this.deps.tasks.getDetails(id));
    if (req.method === "GET" && action === "trace")
      return sendJson(res, 200, this.deps.tasks.trace(id));
    if (req.method === "POST" && action === "run")
      return sendJson(res, 202, this.deps.tasks.rerun(id));
    if (req.method === "POST" && action === "cancel")
      return sendJson(res, 202, this.deps.tasks.cancel(id));
    if (req.method === "POST" && action === "revise") {
      const body = await readJson(req);
      return sendJson(res, 202, {
        task: await this.deps.tasks.revise(id, taskRevisionInput(body)),
      });
    }
    if (req.method === "POST" && action === "document") {
      const body = await readJson(req);
      if (typeof body.markdown !== "string")
        throw badRequest("markdown must be a string");
      return sendJson(res, 201, {
        artifact: await this.deps.tasks.saveDocument(id, body.markdown),
      });
    }
    throw notFound("route not found");
  }
  private async createBrowserSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    sendJson(
      res,
      201,
      await this.deps.browser.create(
        body.url === undefined ? undefined : browserUrl(body.url),
      ),
    );
  }
  private async browserRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
    action?: string,
  ) {
    if (req.method === "DELETE" && !action) {
      await this.deps.browser.close(sessionId);
      return sendJson(res, 204, {});
    }
    if (req.method === "POST" && action === "actions")
      return sendJson(
        res,
        200,
        await this.deps.browser.perform(
          sessionId,
          browserAction(await readJson(req)),
        ),
      );
    throw notFound("route not found");
  }
  private async performComputerAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    sendJson(res, 200, await this.deps.computer.execute(computerAction(body)));
  }
  private async searchWeb(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    const query = asString(body.query, "query", true)!.trim();
    const limit = body.limit ?? 3;
    if (!query || query.length > 500)
      throw badRequest("query must contain 1 to 500 characters");
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 5
    )
      throw badRequest("limit must be between 1 and 5");
    try {
      sendJson(res, 200, {
        items: await this.deps.browser.search(query, limit),
      });
    } catch {
      throw unavailable(
        "웹 검색을 실행하지 못했습니다. SearXNG 서버 실행 상태와 Chrome 설정을 확인하세요.",
      );
    }
  }
  private async searchLegalLibrary(url: URL, res: http.ServerResponse) {
    if (!this.deps.legalRetrieval)
      throw unavailable("법률 자료 검색이 설정되지 않았습니다.");
    const query = url.searchParams.get("q");
    if (
      query === null ||
      !query.trim() ||
      query.length > env.legal.maxQueryCharacters
    )
      throw badRequest(
        `q must contain 1 to ${env.legal.maxQueryCharacters} characters`,
      );
    const corpus = url.searchParams.get("corpus") ?? "law";
    if (
      corpus !== "law" &&
      corpus !== "precedent" &&
      corpus !== "graph" &&
      corpus !== "all"
    )
      throw badRequest("corpus must be law, precedent, graph, or all");
    const requestedLimit = Number(
      url.searchParams.get("limit") ??
        (corpus === "law" || corpus === "all"
          ? 20
          : corpus === "graph"
            ? 30
            : 10),
    );
    const maxLimit =
      corpus === "law" || corpus === "all" ? 20 : corpus === "graph" ? 30 : 10;
    if (
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > maxLimit
    )
      throw badRequest(`limit must be between 1 and ${maxLimit}`);
    const records =
      corpus === "law"
        ? await this.deps.legalRetrieval.searchLaws(query, requestedLimit)
        : corpus === "precedent"
          ? await this.deps.legalRetrieval.searchPrecedents(
              query,
              requestedLimit,
            )
          : corpus === "graph"
            ? await this.deps.legalRetrieval.searchGraph(query, requestedLimit)
            : (
                await Promise.all([
                  this.deps.legalRetrieval.searchLaws(query, requestedLimit),
                  this.deps.legalRetrieval.searchPrecedents(query, 10),
                ])
              ).flat();
    return sendJson(res, 200, {
      query,
      corpus,
      items: assignCitationIds(records),
    });
  }
  private async readLegalPrecedent(url: URL, res: http.ServerResponse) {
    if (!this.deps.legalRetrieval)
      throw unavailable("법률 자료 검색이 설정되지 않았습니다.");
    const identifier = url.searchParams.get("identifier");
    if (identifier === null || !identifier.trim() || identifier.length > 160)
      throw badRequest("identifier must contain 1 to 160 characters");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000)
      throw badRequest("offset must be between 0 and 2000000");
    const { record, paging, pageLength } =
      await this.deps.legalRetrieval.getPrecedentDocument(identifier, offset);
    return sendJson(res, 200, {
      item: assignCitationIds([record])[0],
      paging,
      nextOffset: (paging.offset ?? offset) + pageLength,
    });
  }
  private async uploadFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    const file = await this.deps.files.uploadBase64({
      name: asString(body.name, "name", true)!,
      mimeType: asString(body.mimeType, "mimeType", true)!,
      base64: asString(body.base64, "base64", true)!,
    });
    sendJson(res, 201, { file });
  }
  private async getFile(res: http.ServerResponse, id: string) {
    const file = await this.deps.files.get(id);
    if (!file) throw notFound("file not found");
    sendJson(res, 200, { file });
  }
  private async getFileContent(res: http.ServerResponse, id: string) {
    const { metadata, content } = await this.deps.files.read(id);
    const origin = responseOrigin(res);
    const fallback =
      metadata.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
    const encoded = encodeURIComponent(metadata.name).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.writeHead(200, {
      "content-type": metadata.mimeType,
      "content-length": content.length,
      "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "access-control-expose-headers": "content-disposition",
      ...(origin ? { "access-control-allow-origin": origin } : {}),
    });
    res.end(content);
  }
  private async editSpreadsheet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    const file = await this.deps.spreadsheets.edit({
      fileId: asString(body.fileId, "fileId", true)!,
      outputName: asString(body.outputName, "outputName", true)!,
      operations: spreadsheetOperations(body.operations),
    });
    sendJson(res, 201, { file });
  }
  private async createSpreadsheet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    const file = await this.deps.spreadsheets.create({
      outputName: asString(body.outputName, "outputName", true)!,
      operations: spreadsheetOperations(body.operations),
    });
    sendJson(res, 201, { file });
  }
  private async createMarkdown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    const markdown = asString(body.markdown, "markdown", true)!;
    if (markdown.length > 200_000)
      throw badRequest("markdown must not exceed 200000 characters");
    sendJson(res, 201, {
      file: await this.deps.documents.createMarkdownReport({
        outputName: asString(body.outputName, "outputName", true)!,
        markdown,
      }),
    });
  }
  private async exportMarkdown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    const format = asString(body.format, "format", true);
    const outputName = asString(body.outputName, "outputName", true)!;
    const markdown = asString(body.markdown, "markdown", true)!;
    if (markdown.length > 200_000)
      throw badRequest("markdown must not exceed 200000 characters");
    if (format === "xlsx") {
      sendJson(res, 201, {
        file: await this.deps.spreadsheets.createMarkdownReport({
          outputName,
          markdown,
        }),
      });
      return;
    }
    if (format === "pdf") {
      sendJson(res, 201, {
        file: await this.deps.pdfs.createMarkdownReport({
          outputName,
          markdown,
        }),
      });
      return;
    }
    throw badRequest("format must be xlsx or pdf");
  }
  private async inspectSpreadsheet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    sendJson(
      res,
      200,
      await this.deps.spreadsheets.inspect(spreadsheetInspectInput(body)),
    );
  }
  private async createDocument(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    if (
      !Array.isArray(body.paragraphs) ||
      !body.paragraphs.every((item) => typeof item === "string")
    )
      throw badRequest("paragraphs must be a string array");
    const file = await this.deps.documents.create({
      outputName: asString(body.outputName, "outputName", true)!,
      title: asString(body.title, "title", true)!,
      paragraphs: body.paragraphs,
    });
    sendJson(res, 201, { file });
  }
  private async fillDocumentTemplate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    if (
      !body.variables ||
      typeof body.variables !== "object" ||
      Array.isArray(body.variables)
    )
      throw badRequest("variables must be an object");
    const file = await this.deps.documents.fillTemplate({
      fileId: asString(body.fileId, "fileId", true)!,
      outputName: asString(body.outputName, "outputName", true)!,
      variables: body.variables as Record<string, string | number | boolean>,
    });
    sendJson(res, 201, { file });
  }
  private async extractDocument(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    sendJson(
      res,
      200,
      await this.deps.content.extract(asString(body.fileId, "fileId", true)!),
    );
  }
  private async compareDocuments(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    sendJson(
      res,
      200,
      await this.deps.content.compare(
        asString(body.leftFileId, "leftFileId", true)!,
        asString(body.rightFileId, "rightFileId", true)!,
      ),
    );
  }
  private async redactDocument(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    if (
      !Array.isArray(body.rules) ||
      !body.rules.every((rule) =>
        ["email", "phone", "residentId"].includes(String(rule)),
      )
    )
      throw badRequest("rules must contain email, phone, or residentId");
    sendJson(
      res,
      201,
      await this.deps.redaction.redact({
        fileId: asString(body.fileId, "fileId", true)!,
        outputName: asString(body.outputName, "outputName", true)!,
        rules: body.rules as RedactionRule[],
      }),
    );
  }
  private async mergePdfs(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    if (
      !Array.isArray(body.fileIds) ||
      !body.fileIds.every((id) => typeof id === "string")
    )
      throw badRequest("fileIds must be a string array");
    sendJson(res, 201, {
      file: await this.deps.pdfs.merge({
        fileIds: body.fileIds,
        outputName: asString(body.outputName, "outputName", true)!,
      }),
    });
  }
  private async splitPdf(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    if (
      !Array.isArray(body.pageNumbers) ||
      !body.pageNumbers.every((value) => typeof value === "number")
    )
      throw badRequest("pageNumbers must be a number array");
    sendJson(res, 201, {
      files: await this.deps.pdfs.split({
        fileId: asString(body.fileId, "fileId", true)!,
        pageNumbers: body.pageNumbers,
        outputPrefix: asString(body.outputPrefix, "outputPrefix", true)!,
      }),
    });
  }
  private async editPdf(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    const operation = body.operation as {
      kind?: unknown;
      pageNumbers?: unknown;
      degrees?: unknown;
    };
    if (
      !["reorder", "removePages", "rotatePages"].includes(
        String(operation?.kind),
      ) ||
      !Array.isArray(operation?.pageNumbers) ||
      !operation.pageNumbers.every((value) => typeof value === "number")
    )
      throw badRequest("invalid PDF edit operation");
    sendJson(res, 201, {
      file: await this.deps.pdfs.edit({
        fileId: asString(body.fileId, "fileId", true)!,
        outputName: asString(body.outputName, "outputName", true)!,
        operation: {
          kind: operation.kind as "reorder" | "removePages" | "rotatePages",
          pageNumbers: operation.pageNumbers,
          degrees:
            typeof operation.degrees === "number"
              ? operation.degrees
              : undefined,
        },
      }),
    });
  }
  private async replaceDocumentText(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    if (
      !Array.isArray(body.replacements) ||
      !body.replacements.every(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { find?: unknown }).find === "string" &&
          typeof (value as { replace?: unknown }).replace === "string",
      )
    )
      throw badRequest("replacements must contain find and replace strings");
    sendJson(
      res,
      201,
      await this.deps.documents.replaceText({
        fileId: asString(body.fileId, "fileId", true)!,
        outputName: asString(body.outputName, "outputName", true)!,
        replacements: body.replacements as Array<{
          find: string;
          replace: string;
        }>,
      }),
    );
  }
  private async runDocumentAi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readJson(req);
    if (
      !["summarize", "translate", "proofread", "rewrite"].includes(
        String(body.operation),
      )
    )
      throw badRequest("unsupported document AI operation");
    sendJson(
      res,
      201,
      await this.deps.documentAi.run({
        fileId: asString(body.fileId, "fileId", true)!,
        outputName: asString(body.outputName, "outputName", true)!,
        operation: body.operation as AiDocumentOperation,
        targetLanguage: asString(body.targetLanguage, "targetLanguage"),
        instructions: asString(body.instructions, "instructions"),
      }),
    );
  }
}
