import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  env,
  validateLegalConfig,
  validateRuntimeConfig,
} from "./config/env.js";
import { AgentService } from "./application/agent-service.js";
import { TaskService } from "./application/task-service.js";
import { ComputerControlService } from "./application/computer-control-service.js";
import { SqliteTaskRepository } from "./infrastructure/persistence/sqlite-task-repository.js";
import { OpenAiProvider } from "./infrastructure/llm/openai-provider.js";
import { ApiRouter } from "./api/router.js";
import { createApiServer } from "./api/server.js";
import { BrowserUseService } from "./tools/browser-use.js";
import { ComputerUseService } from "./tools/computer-use.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { FileService } from "./application/file-service.js";
import { SpreadsheetService } from "./application/spreadsheet-service.js";
import { DocumentService } from "./application/document-service.js";
import { DocumentContentService } from "./application/document-content-service.js";
import { PdfService } from "./application/pdf-service.js";
import { RedactionService } from "./application/redaction-service.js";
import { DocumentAiService } from "./application/document-ai-service.js";
import { TaskEventBus } from "./application/task-event-bus.js";
import { ApiAuthenticator } from "./api/authentication.js";
import { TerminalOperatorConfirmation } from "./infrastructure/terminal/operator-confirmation.js";
import { createServerShutdown } from "./server-lifecycle.js";
import {
  CapabilityService,
  toLegalCapability,
} from "./application/capability-service.js";
import { SearxngSearchProvider } from "./infrastructure/search/searxng-search-provider.js";
import { McpStdioClient } from "./infrastructure/legal/mcp-stdio-client.js";
import { buildLegalMcpLaunchArgs } from "./infrastructure/legal/mcp-launch.js";
import { LegalRetrievalService } from "./infrastructure/legal/legal-retrieval-service.js";
import { VectorContributionProbe } from "./infrastructure/legal/vector-contribution-probe.js";
import { LegalRequestRouter } from "./application/legal/legal-request-router.js";
import { LegalWorkflow } from "./application/legal/legal-workflow.js";
import { legalFailureMessage } from "./domain/legal-error.js";
import { LegalCatalogService } from "./application/legal/legal-catalog-service.js";

validateRuntimeConfig();
validateLegalConfig();
mkdirSync("data", { recursive: true });
const tasks = new SqliteTaskRepository(env.databaseFile);
const model = new OpenAiProvider({
  apiKey: env.openAiApiKey,
  model: env.openAiModel,
  baseUrl: env.openAiBaseUrl,
});
const browser = new BrowserUseService({
  searchProvider: new SearxngSearchProvider({ baseUrl: env.searxngUrl }),
});
const operatorConfirmation = new TerminalOperatorConfirmation();
const computer = new ComputerControlService(
  new ComputerUseService(),
  operatorConfirmation,
);
const files = new LocalFileStorage();
const documents = new DocumentService(files);
const content = new DocumentContentService(files);
const fileService = new FileService(files, {
  maxUploadBytes: env.maxUploadBytes,
});
const eventBus = new TaskEventBus();

const legalEnv = (options: { useQdrant: boolean }): Record<string, string> => {
  const entries: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    USE_QDRANT: options.useQdrant ? "true" : "false",
    QDRANT_BACKEND: env.legal.vectorBackend,
    QDRANT_PATH: env.legal.qdrantPath,
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION,
    VECTOR_MEMMAP_PATH: env.legal.vectorMemmapPath,
    LEGAL_GRAPH_PATH: env.legal.graphPath,
    LEGAL_ONTOLOGY_PATH: env.legal.ontologyPath,
    OKF_BUNDLE_PATH: env.legal.okfPath,
    NVIDIA_API_KEY: env.openAiApiKey,
    NVIDIA_BASE_URL: env.openAiBaseUrl,
    NVIDIA_EMBED_MODEL: env.legal.embedModel,
    NVIDIA_EMBED_DIM: env.legal.embedDimension,
  };
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
};

const legalClient = new McpStdioClient({
  command: env.legal.python,
  args: buildLegalMcpLaunchArgs(
    env.legal.script,
    path.resolve("data", "legal-rag-mcp.log"),
  ),
  cwd: env.legal.root,
  env: legalEnv({ useQdrant: env.legal.useQdrant }),
  startupTimeoutMs: env.legal.startupTimeoutMs,
  requestTimeoutMs: env.legal.requestTimeoutMs,
  maxResponseCharacters: env.legal.maxResponseCharacters,
  restartBudget: 1,
  stderrTailCharacters: 4_000,
});
const legalRetrieval = new LegalRetrievalService(legalClient, {
  maxToolCalls: env.legal.retrieval.maxToolCalls,
  maxRetrievalSteps: env.legal.retrieval.maxRetrievalSteps,
  maxQueryCharacters: env.legal.maxQueryCharacters,
  maxPrecedentCharacters: env.legal.retrieval.maxPrecedentCharacters,
  graphPath: env.legal.graphPath,
});
const vectorProbe = new VectorContributionProbe({
  enabled: env.legal.useQdrant,
  root: env.legal.root,
  python: env.legal.python,
  script: env.legal.script,
  logPath: path.resolve("data", "legal-rag-mcp.log"),
  env: legalEnv,
  query: env.legal.vectorProbeQuery,
  timeoutMs: env.legal.requestTimeoutMs,
});
const legalRouter = new LegalRequestRouter({
  multiIssueThreshold: env.legal.routing.multiIssueThreshold,
  complexDraftCharacters: env.legal.routing.complexDraftCharacters,
  multiAttachmentThreshold: env.legal.routing.multiAttachmentThreshold,
  directQueryLimit: env.legal.retrieval.directQueryLimit,
});
const legalWorkflow = new LegalWorkflow({
  retrieval: legalRetrieval,
  model,
  limits: {
    maxQueryCharacters: env.legal.maxQueryCharacters,
    orchestratedQueryLimit: env.legal.retrieval.orchestratedQueryLimit,
    maxRetrievalSteps: env.legal.retrieval.maxRetrievalSteps,
    maxToolCalls: env.legal.retrieval.maxToolCalls,
    maxPrecedentCharacters: env.legal.retrieval.maxPrecedentCharacters,
    directSourceLimit: env.legal.retrieval.directSourceLimit,
  },
});
const capabilities = new CapabilityService(
  {
    modelConfigured: Boolean(env.openAiApiKey),
    browserAvailable: browser.isAvailable(),
    computerAvailable: computer.isAvailable(),
    platform: process.platform,
    legal: toLegalCapability({
      enabled: env.legal.enabled,
      root: env.legal.root,
      status: null,
    }),
  },
  {
    maxAgeMs: 60_000,
    read: async () => {
      if (!env.legal.enabled) return null;
      try {
        const [status, vector] = await Promise.all([
          legalRetrieval.knowledgeStatus(),
          vectorProbe.read(),
        ]);
        legalWorkflow.setVectorState(vector);
        return vector.state === "contributing" || vector.state === "ready"
          ? {
              ...status,
              vector: {
                ready: true,
                ...(vector.detail ? { reason: vector.detail } : {}),
              },
            }
          : status;
      } catch (error) {
        capabilities.setLegal(
          toLegalCapability({
            enabled: true,
            root: env.legal.root,
            status: null,
            message: legalFailureMessage(error),
          }),
        );
        return null;
      }
    },
  },
);

const agent = new AgentService(
  tasks,
  model,
  browser,
  content,
  documents,
  eventBus,
  {
    enabled: env.legal.enabled,
    route: (input) => legalRouter.route(input),
    workflow: legalWorkflow,
  },
);
const router = new ApiRouter({
  tasks: new TaskService(tasks, agent, fileService, documents),
  browser,
  computer,
  capabilities,
  legalRetrieval,
  legalCatalog: new LegalCatalogService(env.legal.okfPath),
  files: fileService,
  spreadsheets: new SpreadsheetService(files),
  documents,
  content,
  pdfs: new PdfService(files),
  redaction: new RedactionService(files),
  documentAi: new DocumentAiService(model, content, documents),
  eventBus,
  authenticator: new ApiAuthenticator(
    env.apiAuthEnabled ? env.apiAuthToken : undefined,
  ),
});
const server = createApiServer(router);

server.listen(env.port, "127.0.0.1", () => {
  console.log(
    `TypeScript agent backend listening on http://127.0.0.1:${env.port}`,
  );
  agent.resumePending();
});
const shutdown = createServerShutdown({
  stopAccepting: (callback) => server.close(callback),
  closeConnections: () => server.closeAllConnections(),
  closeConfirmation: () => operatorConfirmation.close(),
  drainAgent: () => agent.drain(),
  closeBrowsers: () => browser.closeAll(),
  closeLegalRetrieval: () => legalRetrieval.close(),
  closePersistence: () => tasks.close(),
});
const handleShutdown = (): void => {
  void shutdown().catch((error) =>
    console.error("backend shutdown failed", error),
  );
};
process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);
