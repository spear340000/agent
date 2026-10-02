# Workfolio Document Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Workfolio’s task screen around a functional, responsive document editor while preserving all existing backend-backed workflows.

**Architecture:** Keep `Workroom` as the data/API orchestrator, but move navigation, task context, and document editing into focused components. Keep Markdown as the persisted source of truth; derive the document outline and toolbar edits from it, and continue using the existing API client and task adapters.

**Tech Stack:** Next.js 15, React 18, TypeScript, existing CSS, `lucide-react`, Node test runner through `tsx`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-29-workfolio-document-workspace-design.md`

## Global Constraints

- Keep the existing green accent and Korean type feel on neutral surfaces.
- Use warm off-white/beige surfaces to reduce glare, and keep desktop navigation collapsible with its preference persisted in browser storage.
- Do not change backend API contracts or persisted data models.
- Do not add a new editor library by default; Markdown remains the source of truth.
- Do not show an “auto-saved” state until persistence is confirmed.
- Do not add fake metrics, progress, user data, or inactive toolbar controls.
- Preserve the actual upload, task, SSE, follow-up, cancellation, retry, save, and export behaviors.
- Do not add Manus branding, logo, or exact branded screen details.
- Preserve the current dirty working-tree changes; do not overwrite or stage unrelated paths.
- Git `user.name` and `user.email` are not configured. Do not invent an author or commit implementation changes until the user configures an identity.

## Review Focus

1. A Markdown heading inside a fenced code block must not appear in the outline — pin with `ignoresHeadingsInsideFencedCodeBlocks` in `documentModel.test.ts`.
2. A document without headings must not show an empty outline rail — pin with `returnsNoOutlineWithoutHeadings` in `documentModel.test.ts` and verify in the browser.
3. Applying bold with no selection must place the caret between the inserted markers — pin with `placesCaretInsideEmptyBoldMarkers` in `documentModel.test.ts`.
4. A failed save must remain visibly unsaved and retryable — pin status precedence with `saveStatePrioritizesErrorAndDirtyContent` in `documentModel.test.ts`; verify the save-error state in the browser/API test path.
5. An SSE refresh must not replace a locally edited, dirty document — pin with `preservesDirtyDocumentWhenTaskDetailsRefresh` in `taskAdapters.test.ts`.

---

### Task 1: Markdown editing and outline model

**Files:**
- Create: `src/components/workroom/documentModel.ts`
- Create: `src/components/workroom/documentModel.test.ts`

**Interfaces:**
- Produces `DocumentHeading = { level: 1 | 2 | 3 | 4 | 5 | 6; title: string; line: number; start: number }`.
- Produces `DocumentCommand = 'heading1' | 'heading2' | 'bold' | 'bullet' | 'quote'`.
- Produces `DocumentEditResult = { value: string; selectionStart: number; selectionEnd: number }`.
- Produces `getDocumentOutline(markdown: string): DocumentHeading[]`.
- Produces `applyDocumentCommand(markdown: string, selectionStart: number, selectionEnd: number, command: DocumentCommand): DocumentEditResult`.
- Produces `getDocumentSaveStatus(state: { dirty: boolean; saving: boolean; error: string | null }): 'error' | 'saving' | 'unsaved' | 'saved'` with precedence error → saving → dirty → saved.

- [x] **Step 1: Write the failing model tests**
  - `extractsOutlineAndOffsetsAcrossLineEndings`: headings 1–6 include title, line and source offset; CRLF and repeated titles retain correct offsets.
  - `ignoresHeadingsInsideFencedCodeBlocks`: a Markdown-looking line inside a fenced block is not an outline entry.
  - `returnsNoOutlineWithoutHeadings`: non-heading Markdown returns `[]`.
  - `appliesMarkdownCommandsAndPreservesSelection`: H1/H2 replace the current line prefix, bold wraps selected text, and bullet/quote prefix every selected line.
  - `placesCaretInsideEmptyBoldMarkers`: an empty selection inserts `****` and returns the caret offset between the markers.
  - `saveStatePrioritizesErrorAndDirtyContent`: error, saving and dirty states never report `saved`.
- [x] **Step 2: Run the focused tests and confirm they fail**

  Run: `..\node_modules\.bin\tsx.cmd --test src\components\workroom\documentModel.test.ts`

  Expected: FAIL because the model module and exports do not exist.
- [x] **Step 3: Implement the three pure functions and exported types in `documentModel.ts`**
  - Keep parsing and edits string-based; do not use DOM parsing or mutate browser state in this module.
  - Preserve selection offsets after each command so the editor can restore focus and caret.
- [x] **Step 4: Re-run the focused tests and confirm they pass**
- [x] **Step 5: Run `pnpm run typecheck`**

### Task 2: Document workspace and outline components

**Files:**
- Create: `src/components/workroom/DocumentOutline.tsx`
- Create: `src/components/workroom/DocumentWorkspace.tsx`
- Create: `src/components/workroom/DocumentWorkspace.test.tsx`

**Interfaces:**
- `DocumentOutlineProps = { headings: DocumentHeading[]; onSelect: (heading: DocumentHeading) => void }`; render no rail when `headings` is empty.
- `DocumentWorkspaceProps = { title: string; value: string; hasPersistedDocument: boolean; dirty: boolean; saving: boolean; saveError: string | null; onChange: (value: string) => void; onSave: () => Promise<void>; onExport: (format: 'md' | 'docx') => void }`. Hide the saved indicator when no persisted artifact exists; a clean initial state is not proof of persistence.
- The workspace consumes Task 1’s model and reports text changes through `onChange`; the parent remains the owner of persistence state.

- [x] **Step 1: Write server-render tests `rendersSupportedToolbarAndSaveStates` and `omitsEmptyOutline` in `DocumentWorkspace.test.tsx`**
  - Assert the toolbar exposes only heading 1, heading 2, bold, bullet, and quote actions, plus Save, Markdown, and DOCX controls.
  - Assert clean, dirty, saving, and failed-save states render the matching `getDocumentSaveStatus` label.
  - Assert the outline component renders no markup when its heading list is empty.
- [x] **Step 2: Run `..\node_modules\.bin\tsx.cmd --test src\components\workroom\DocumentWorkspace.test.tsx` and confirm the new component imports fail**
- [x] **Step 3: Implement the outline and editor**
  - Provide an accessible title field display, an editable document canvas, the five functional Markdown actions, a save action, and Markdown/DOCX export actions.
  - Restore the textarea selection after applying a command; outline selection focuses/selects the corresponding heading offset.
  - Disable save when clean or saving; on error retain the edited value and allow retry.
  - Send export clicks to the parent; the existing handler remains the single path for backend artifacts and client-generated exports.
- [x] **Step 4: Run the focused test, model tests, and typecheck**
  - Expected: PASS; no new dependency or fake toolbar control.

### Task 3: Task context panel

**Files:**
- Create: `src/components/workroom/TaskContextPanel.tsx`
- Create: `src/components/workroom/TaskContextPanel.test.tsx`

**Interfaces:**
- `TaskContextPanelProps = { task: Task; mobileOpen: boolean; onMobileOpenChange: (open: boolean) => void; onCancel: () => void; onRerun: () => void; onFollowup: (request: string, kind?: 'revision' | 'followup') => Promise<boolean> }`. A small request-mode toggle keeps the existing revision and follow-up API actions available through one composer.
- The panel consumes `Task`, `stageMeta`, `stageOrder`, `Sources`, and the existing compact `Composer`; it owns no backend state.

- [x] **Step 1: Write server-render tests `showsActionsForActionableTaskStates` and `rendersTaskRequestAndSources` in `TaskContextPanel.test.tsx`**
  - Assert queued/running states show a cancel action, failed shows retry, completed shows neither, and all five states display backend-derived copy without invented percentages.
  - Assert the actual request and source names render in the context panel.
- [x] **Step 2: Run `..\node_modules\.bin\tsx.cmd --test src\components\workroom\TaskContextPanel.test.tsx` and confirm the new component import fails**
- [x] **Step 3: Move request, sources, timeline, error/cancel/retry actions, prior follow-ups, and compact follow-up composer into `TaskContextPanel.tsx`**
  - Render cancel only for queued/running and retry only for failed tasks.
  - Preserve the actual status and error returned by the backend.
- [x] **Step 4: Run the focused test and typecheck**

### Task 4: Workfolio navigation and screen composition

**Files:**
- Create: `src/components/workroom/WorkfolioSidebar.tsx`
- Modify: `src/components/workroom/Workroom.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/workroom/taskAdapters.test.ts`

**Interfaces:**
- `WorkfolioSidebarProps = { tasks: Task[]; activeTaskId: string | null; filter: 'all' | 'active' | 'completed'; onFilterChange: (filter: 'all' | 'active' | 'completed') => void; onOpenTask: (id: string | null) => void }`.
- Sidebar width and its existing localStorage persistence stay inside `WorkfolioSidebar`; the parent controls mobile drawer visibility.
- Pass the parent-controlled drawer state as `mobileOpen: boolean` and `onMobileOpenChange(open: boolean)`.
- `Workroom` remains the owner of task loading, API calls, SSE lifecycle, active selection, dirty-document state, and save errors.
- `Workroom` passes the Task 2 editor props and Task 3 task-context callbacks without changing `src/api/workroom.ts` contracts.

- [x] **Step 1: Add `preservesDirtyDocumentWhenTaskDetailsRefresh` to `taskAdapters.test.ts`**
  - Map an SSE/detail update over a prior task with a locally edited dirty document and assert both the edited Markdown and dirty flag remain unchanged while backend task state updates.
- [x] **Step 2: Run `..\node_modules\.bin\tsx.cmd --test src\components\workroom\taskAdapters.test.ts` and record the baseline**
  - This is a characterization test: the current adapter is expected to pass before the UI refactor; it guards the behavior during extraction.
- [x] **Step 3: Extract task navigation and compose the four-column active-task screen**
  - Preserve task filters, selection, new-task action, upload, SSE, follow-up, cancel, rerun, save and export behavior.
  - Keep the selected document in local task state during SSE refresh; mark it clean only after a successful save response.
  - Remove nonfunctional search/account chrome and the decorative `DocumentConstellation`; retain only real controls and actual task data.
  - Keep a truthful no-task composer state and real backend loading/offline/error messages within the same shell.
  - Change visible brand text and Next metadata from `Workroom` to `Workfolio`.
- [x] **Step 4: Run `DocumentWorkspace.test.tsx`, `TaskContextPanel.test.tsx`, `taskAdapters.test.ts`, `workroom.test.ts`, and typecheck**

### Task 5: Responsive styling and interaction verification

**Files:**
- Modify: `src/app/workroom.css`
- Create or update: `design-qa.md`

**Interfaces:**
- Desktop grid order: navigation → task context → document outline (only when headings exist) → document canvas.
- At narrow widths, navigation/context become keyboard-accessible drawers or collapsible regions; the document canvas remains usable without horizontal page overflow.

- [x] **Step 1: Implement restrained styles for the new components**
  - At 1440×1024 keep the editor as the dominant area; retain the green accent, Korean type feel, neutral background and thin separators.
  - Remove obsolete rules for deleted decorative UI where safe; do not rewrite unrelated global styles.
- [x] **Step 2: Run typecheck, lint, focused tests, formatting, and production build**
  - Run build with the existing `localhost:3000` Next dev process stopped; identify and stop only the exact frontend dev process, then restart it after build to avoid the prior dev/build memory collision.
  - Confirm `pnpm-lock.yaml` has no unintended pnpm-version rewrite before handoff.
- [ ] **Step 3: Verify the rendered app in the user-selected in-app browser**
  - Compare the selected reference and app at 1440×1024 on an active document state; also inspect a 390px-wide mobile state.
  - Use the existing completed smoke-test task and do not create another paid model task.
  - Verify heading navigation, a Markdown edit + save, save failure/retry state where safely reproducible, Markdown/DOCX export, task history selection, and mobile drawer/overflow behavior.
- [x] **Step 4: Write `design-qa.md` with the comparison evidence and fix all P0–P2 mismatches**
  - Capture the revised implementation and compare again after fixes.
  - Final gate: `design-qa.md` says `final result: passed`; otherwise record `final result: blocked` and the specific blocker.

## Execution Notes

- Current worktree already contains uncommitted backend-integration work in files touched by this plan. Preserve it; do not reset, stash, stage, or commit those existing changes as part of this UI work.
- The design spec is approved but could not be committed because Git author identity is not configured. Its file is currently staged alone. Keep the implementation plan uncommitted and do not invent an author identity.
- For desktop/browser checks, use the user’s Codex In-app Browser. Do not drive Playwright CLI or MCP directly.

## Icon selection note

The app already includes `lucide-react`. Lucide’s official documentation describes customizable stroke width and tree-shakable imports, while Iconoir provides a React package with a 1.5px default stroke. The screenshot’s restrained outline controls and the existing app’s consistent Lucide use favor reusing the installed library instead of adding an icon dependency: [Lucide](https://lucide.dev/), [Iconoir React](https://iconoir.com/docs/packages/iconoir-react).
