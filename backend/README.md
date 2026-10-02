# TypeScript Agent Runtime

```bash
npm run backend
```

For local single-user use, API bearer authentication is off by default: the server binds only to `127.0.0.1` and checks browser origins against an exact allowlist. This is not multi-user isolation; other processes running as the same OS user can call the local API. To require a bearer token, explicitly set `API_AUTH_ENABLED=true` and `API_AUTH_TOKEN` (at least 32 characters). Generate one with `npm run auth:token`; the command prints a one-time random value and does not save it.

Browser frontends on `localhost` or `127.0.0.1` ports 3000 and 3001 are allowed by default. Set `FRONTEND_ORIGINS` to a comma-separated list of exact origins when hosting the frontend elsewhere.

The backend persists tasks, events, and artifacts in SQLite (`data/agent.db`). Source code lives under `backend/src/` as TypeScript; `npm run build` generates `dist/backend/` at the workspace root.

## Architecture

```text
src/
  api/             HTTP contracts, routing, responses
  application/     use cases and orchestration
  config/          environment loading and typed runtime settings
  domain/          entities and dependency contracts
  infrastructure/  SQLite and OpenAI adapters
  cli/             local operator commands
  shared/          application errors and cross-cutting utilities
  tools/           browser and computer use adapters
```

Dependency direction is one-way: `api -> application -> domain`, while `infrastructure` provides implementations of domain contracts. Do not import API code from application/domain code, and keep provider-specific code inside `infrastructure`.

## Maintenance rules

- Add a feature through an application service before exposing an API route.
- Keep HTTP validation in `api/contracts.ts`.
- Keep SQL inside `infrastructure/persistence`.
- Add a domain contract before introducing a new provider or database adapter.
- Every bug fix needs a regression test under `backend/tests`.
- Add new environment values in `config/env.ts`, not with raw `process.env` reads elsewhere.

## Agent APIs

- `GET /health`
- `GET /api/tasks`
- `GET /api/capabilities` (reports configured/available features, never credentials)
- `POST /api/tasks` — `{ "prompt": "...", "title": "optional", "sourceFileIds": ["file_..."], "sourceUrls": ["https://..."] }`; accepts up to 5 PDF/DOCX/XLSX/PPTX or text/CSV source files and 5 HTTP(S) URLs
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/events` — Server-Sent Events stream, including replay of persisted progress events
- `POST /api/tasks/:id/revise` — `{ "kind": "revision" | "followup", "message": "...", "sourceFileIds": [], "sourceUrls": [] }`; adds a revision to the same task, persists it as an event, and reruns with the retained sources
- `POST /api/tasks/:id/document` — `{ "markdown": "..." }`; saves an edited Markdown document as a new DOCX artifact version (completed tasks only)
- `POST /api/tasks/:id/run`
- `POST /api/tasks/:id/cancel` — cancels queued work immediately or aborts in-flight model/web requests
- `GET /api/artifacts/:id`

Task execution plans the request, extracts attached PDF/DOCX/XLSX/PPTX and text/CSV sources, searches through the configured SearXNG instance, reads supplied public URLs and result pages in headless Chrome, analyzes the evidence, then produces a source-cited DOCX. Revision and follow-up requests update the same task and retain its event/artifact history. Versioned stage checkpoints are reused only when their input fingerprint matches; queued/running tasks resume on backend startup. Web research requires a working SearXNG instance at `SEARXNG_URL` (default `http://127.0.0.1:8888`), Chrome, and external network access; report generation requires an OpenAI-compatible endpoint. `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, and `NVIDIA_MODEL` take precedence when set; otherwise the `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` settings are used. Prompts and extracted document text are sent to the configured model endpoint, while generated search queries are sent to SearXNG and browser requests to source sites; avoid submitting material you are not allowed to share with those providers. Search/provider failures fail the research stage explicitly instead of silently treating blocked search results as an empty search. Generated citations are checked against retrieved source IDs, with one repair attempt before failure.

### Local SearXNG search service

The planner can return no search queries for source-only, creative, or editing requests; those workflows do not contact SearXNG. Revisions pin the latest artifact present when the request is accepted, including manually saved edits. An invalid plan fails explicitly rather than inventing search queries. Model quota exhaustion is reported immediately as an actionable service error, without pointless retries or upstream error-body disclosure.

The local SearXNG deployment listens only on `127.0.0.1:8888`; JSON output is enabled for the backend adapter. Start it with `npm run searxng:up`, inspect it with `npm run searxng:status`, and stop it with `npm run searxng:down`. The first start generates a private random instance secret under `backend/ops/searxng/.env`; do not commit that file. SearXNG aggregates external engines, so individual engines can still rate-limit or temporarily return no matches. Search result snippets are retained separately from verified source-page text, and sources that cannot be read are not cited as retrieved evidence.

## Runtime safeguards

- Uploads default to 10 MiB (`MAX_UPLOAD_BYTES`) and JSON request bodies to 16 MiB (`MAX_REQUEST_BYTES`). The backend checks base64 syntax, extension/MIME agreement, and PDF/Office archive signatures.
- By default, `/api/*` is available without a bearer token to local callers. Set `API_AUTH_ENABLED=true` to require `Authorization: Bearer <API_AUTH_TOKEN>`; only then must the token be at least 32 characters. Exact browser Origin checks remain enabled in both modes, and the server stays bound to loopback.
- Browser navigation and subresource traffic use a loopback-only TypeScript egress proxy. For each HTTP request or HTTPS/WebSocket tunnel, the proxy resolves and validates every DNS answer, selects a validated public IP, and opens the socket directly to that IP while preserving the original HTTP Host or TLS SNI. Chromium is configured to use the proxy and to avoid direct DNS lookups. Only HTTP(S) ports 80 and 443 are allowed. This closes the DNS check-to-connect rebinding gap for browser traffic; it does not isolate other processes running as the same OS user. Search visits at most six source pages per task and stores retrieved text with retrieval timestamps.
- Browser instances are limited by `MAX_BROWSER_SESSIONS` (default 4). The server binds to loopback, sets request/header timeouts, limits concurrent agent tasks to two, and drains active jobs on shutdown.
- Task-list responses, task event history, and task artifact history are each capped at 100 newest/oldest records by their SQLite repository queries. When a task has more than 100 events or artifacts, its detail/history response contains the most recent 100; event order remains chronological.
- Tasks, prompts, events, checkpoints, artifacts, and uploaded files persist locally without encryption or automatic retention. There is deliberately no file/task delete API yet: files may be referenced by task inputs or artifact records, and deleting them without coordinated referential cleanup risks broken history/downloads. Back up and remove the local `data/` directory only while the backend is stopped and only when you intend to erase all local records and files.
- The OpenAI-compatible model client caps combined system/user input at 200,000 characters and response bodies at 2 MiB by default; individual requests time out after 60 seconds and transient HTTP/network failures are retried at most three attempts. Provider response bodies and credentials are not included in API errors.
- `GET /api/capabilities` reports actual configured/available status. Google Docs/Sheets adapters, OCR, and formula calculation are unavailable; a working DOCX/XLSX/PDF local adapter does not imply full Office rendering or feature parity.

Example flow: upload each PDF via `POST /api/files`, pass returned file IDs as `sourceFileIds` when creating a task, poll `GET /api/tasks/:id` or stream events, then download the generated DOCX from `GET /api/files/:fileId/content` using the artifact's `fileId`. If bearer authentication is explicitly enabled, send the configured Authorization header on each request; native browser `EventSource` cannot attach it, so use authenticated `fetch` streaming instead.

## Browser use APIs

- `POST /api/search` — searches SearXNG and reads public source pages; returns explicit failure if the service is unavailable
- `POST /api/browser/sessions` — `{ "url": "https://example.com" }`
- `POST /api/browser/sessions/:sessionId/actions`
- `DELETE /api/browser/sessions/:sessionId`

Supported browser actions are `navigate`, `click`, `type`, `extractText`, and `screenshot`. Configure `BROWSER_EXECUTABLE_PATH` if Chrome is installed outside its common Windows locations.

Browser APIs follow the same optional bearer-auth setting as other `/api/*` routes. Browser-session creation is bounded by `MAX_BROWSER_SESSIONS` (default 4). All browser HTTP, HTTPS CONNECT, and WebSocket traffic is routed through the local egress proxy, which dials the validated DNS answer directly rather than asking Chromium to resolve the destination. The proxy rejects private/mixed DNS results and is closed with the browser service.

## Computer use APIs

- `POST /api/computer/actions`

Computer APIs follow the same optional bearer-auth setting and still require `COMPUTER_USE_ENABLED=true` on Windows. Screenshots are read-only. Click and type wait for a visible prompt in the terminal running the backend; inspect the displayed coordinates or text and type `yes` to execute. Prompts are serialized, at most 8 may be pending, and a queued batch expires after 60 seconds. Declining, timeout, a full queue, or running without an interactive terminal rejects the action. The old `/api/computer/approvals` token endpoint has been removed; a token issued by the action caller is not treated as human consent.

## Office file automation APIs

- `POST /api/files` — stores an input file with `{ name, mimeType, base64 }`
- `GET /api/files` — lists managed files with bounded `limit`, `cursor`, and name `search` parameters
- `GET /api/files/:id` — returns managed file metadata
- `GET /api/files/:id/content` — downloads the managed file bytes
- `POST /api/spreadsheets/edit` — edits an uploaded `.xlsx` and returns a new file record
- `POST /api/spreadsheets/create` — creates a real `.xlsx`; its operation list must add a sheet
- `POST /api/spreadsheets/inspect` — returns bounded sheet/range/cell/formula metadata
- `POST /api/documents/create` — creates a `.docx` from title and paragraphs
- `POST /api/documents/markdown` — creates a `.docx` from bounded Markdown input
- `POST /api/documents/template-fill` — fills `{variable}` fields in an uploaded `.docx` template and returns a new file record
- `POST /api/documents/extract` — extracts text from `.docx`, `.pdf`, or text files
- `POST /api/documents/compare` — returns line-level additions and removals between two documents
- `POST /api/documents/redact` — detects selected PII patterns and creates a new redacted `.docx`
- `POST /api/documents/replace-text` — preserves an existing DOCX and replaces literal text across adjacent Word runs in body, headers/footers, notes/comments, and document properties
- `POST /api/documents/ai` — summarizes, translates, proofreads, or rewrites an extractable document using the configured model
- `POST /api/pdfs/merge` — joins two or more uploaded PDFs
- `POST /api/pdfs/inspect` — reports page counts, sizes, and rotations
- `POST /api/pdfs/split` — exports selected source PDF pages as separate files
- `POST /api/pdfs/edit` — reorders, removes, or rotates selected PDF pages

Spreadsheet operations are `setCell`, `setFormula`, `appendRows`, and `addSheet`. Inspect reports formula text and whether recalculation is required; formulas are not executed or recalculated by this service. Macro-enabled files, external workbook links, and external data connections are rejected rather than silently dropped. Source files are immutable: each document or spreadsheet edit creates a new managed output under `data/files`.

Redaction rules are `email`, `phone`, and `residentId`. DOCX redaction checks package XML and fails if detected original values remain, but cannot redact text embedded in images or other non-text payloads. OCR is intentionally kept as a future adapter: scanned image-only PDFs are reported as having no extractable text rather than producing unverified text.

DOCX direct replacement preserves surrounding run styling while matching literal text split across adjacent Word runs. It is not a full Word layout/rendering engine. Use template-fill for variable-driven documents. AI operations need the configured model endpoint and only run against documents with extractable text.

## Test classes

- `npm run check` type-checks the backend without emitting build files.
- `npm run test:backend` runs deterministic local unit/integration tests; test bootstrap sets test mode before application modules load, and the suite does not require `.env` values or external model/search services.
- `BROWSER_INTEGRATION_TESTS=true` plus an explicitly configured Chrome executable and operator-supplied public test URL enables the real-browser integration test. `COMPUTER_INTEGRATION_TESTS=true`, `COMPUTER_TEST_ALLOW_SCREEN_CAPTURE=true`, and `COMPUTER_USE_ENABLED=true` enable a read-only real Windows screenshot smoke test. Both are skipped by default; desktop clicking/typing is never part of the automated integration suite.
