import { realpath, readdir, readFile, stat, open } from "node:fs/promises";
import path from "node:path";
import { badRequest, notFound, unavailable } from "../../shared/app-error.js";

const MAX_PAGE_CHARACTERS = 30_000;
const MAX_WIKI_FILE_BYTES = 25 * 1024 * 1024;

export type LegalWikiPageSummary = {
  name: string;
  title: string;
  bytes: number;
};

export type LegalWikiPageChunk = {
  name: string;
  content: string;
  offset: number;
  nextOffset: number;
  totalCharacters: number;
  hasMore: boolean;
};

export type LegalWikiEntry = {
  title: string;
  status?: string;
  effectiveDate?: string;
  offset: number;
  endOffset: number;
  excerpt: string;
};

type CachedEntryIndex = {
  modifiedAt: number;
  bytes: number;
  entries: LegalWikiEntry[];
};

export class LegalWikiService {
  private readonly entryIndexes = new Map<string, CachedEntryIndex>();

  constructor(private readonly wikiRoot: string) {}

  async list(): Promise<LegalWikiPageSummary[]> {
    const root = await this.resolveRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const pages: LegalWikiPageSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md"))
        continue;
      const file = path.join(root, entry.name);
      const metadata = await stat(file);
      const title = (await readPageTitle(file))
        ?? entry.name.replace(/\.md$/iu, "").replace(/[-_]+/gu, " ");
      pages.push({
        name: entry.name,
        title,
        bytes: metadata.size,
      });
    }
    return pages.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }

  async readPage(
    name: string,
    offset = 0,
    limit = 12_000,
  ): Promise<LegalWikiPageChunk> {
    if (
      !/^[\p{L}\p{N}][\p{L}\p{N} ()._-]{0,180}\.md$/iu.test(name)
    )
      throw badRequest("invalid Wiki page name");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw badRequest("offset must be a non-negative integer");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_CHARACTERS
    )
      throw badRequest(`limit must be between 1 and ${MAX_PAGE_CHARACTERS}`);

    const root = await this.resolveRoot();
    const candidate = path.join(root, name);
    let file: string;
    try {
      file = await realpath(candidate);
    } catch {
      throw notFound("Wiki page not found");
    }
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw notFound("Wiki page not found");
    const metadata = await stat(file);
    if (!metadata.isFile()) throw notFound("Wiki page not found");
    if (metadata.size > MAX_WIKI_FILE_BYTES)
      throw badRequest("Wiki page exceeds the read-only preview size limit");

    const content = await readFile(file, "utf8");
    if (offset > content.length)
      throw badRequest("offset exceeds the Wiki page length");
    if (
      offset > 0 &&
      offset < content.length &&
      isLowSurrogate(content.charCodeAt(offset))
    )
      throw badRequest("offset must not split a Unicode character");
    let end = Math.min(content.length, offset + limit);
    if (
      end < content.length &&
      isHighSurrogate(content.charCodeAt(end - 1)) &&
      isLowSurrogate(content.charCodeAt(end))
    )
      end += 1;
    return {
      name,
      content: content.slice(offset, end),
      offset,
      nextOffset: end,
      totalCharacters: content.length,
      hasMore: end < content.length,
    };
  }

  async listEntries(
    name: string,
    query = "",
    offset = 0,
    limit = 50,
  ): Promise<{
    name: string;
    query: string;
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
    items: LegalWikiEntry[];
  }> {
    this.validatePageName(name);
    if (query.length > 300) throw badRequest("q must be at most 300 characters");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
      throw badRequest("offset must be between 0 and 1000000");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw badRequest("limit must be between 1 and 100");

    const { file, metadata } = await this.resolvePage(name);
    if (metadata.size > MAX_WIKI_FILE_BYTES)
      throw badRequest("Wiki page exceeds the read-only preview size limit");
    const cached = this.entryIndexes.get(file);
    let entries: LegalWikiEntry[];
    if (cached && cached.bytes === metadata.size && cached.modifiedAt === metadata.mtimeMs) {
      entries = cached.entries;
    } else {
      const content = await readFile(file, "utf8");
      entries = indexWikiEntries(content, name);
      this.entryIndexes.set(file, {
        bytes: metadata.size,
        modifiedAt: metadata.mtimeMs,
        entries,
      });
    }

    const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
    const matches = normalizedQuery
      ? entries.filter((entry) =>
          entry.title.toLocaleLowerCase("ko-KR").includes(normalizedQuery),
        )
      : entries;
    const items = matches.slice(offset, offset + limit);
    return {
      name,
      query,
      offset,
      limit,
      total: matches.length,
      hasMore: offset + items.length < matches.length,
      items,
    };
  }

  private async resolveRoot(): Promise<string> {
    try {
      return await realpath(this.wikiRoot);
    } catch {
      throw unavailable(
        "법률 Wiki 폴더를 읽을 수 없습니다. 읽기 전용 Wiki 경로를 확인하세요.",
      );
    }
  }

  private validatePageName(name: string): void {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ()._-]{0,180}\.md$/iu.test(name))
      throw badRequest("invalid Wiki page name");
  }

  private async resolvePage(name: string) {
    const root = await this.resolveRoot();
    const candidate = path.join(root, name);
    let file: string;
    try {
      file = await realpath(candidate);
    } catch {
      throw notFound("Wiki page not found");
    }
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw notFound("Wiki page not found");
    const metadata = await stat(file);
    if (!metadata.isFile()) throw notFound("Wiki page not found");
    return { file, metadata };
  }
}

function indexWikiEntries(content: string, name: string): LegalWikiEntry[] {
  const lines: Array<{ value: string; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const end = newline < 0 ? content.length : newline + 1;
    lines.push({
      value: content.slice(cursor, newline < 0 ? end : newline).replace(/\r$/u, ""),
      start: cursor,
      end,
    });
    cursor = end;
  }

  const starts: Array<{
    offset: number;
    bodyOffset: number;
    title: string;
    status?: string;
    effectiveDate?: string;
  }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.value !== "---") continue;
    let closing = index + 1;
    while (closing < lines.length && lines[closing]!.value !== "---") closing += 1;
    if (closing >= lines.length) continue;
    const frontmatter = lines.slice(index + 1, closing).map((line) => line.value).join("\n");
    const titleValue = /^제목:\s*(.+)$/mu.exec(frontmatter)?.[1]
      ?? (/^type:\s*Document\s*$/mu.test(frontmatter)
        ? undefined
        : /^title:\s*(.+)$/mu.exec(frontmatter)?.[1]);
    if (!titleValue) continue;
    const title = titleValue.trim().replace(/^(["'])(.*)\1$/u, "$2");
    if (!title) continue;
    const field = (key: string) =>
      new RegExp(`^${key}:\\s*(.+)$`, "mu")
        .exec(frontmatter)?.[1]
        ?.trim()
        .replace(/^(["'])(.*)\1$/u, "$2");
    starts.push({
      offset: lines[index]!.start,
      bodyOffset: lines[closing]!.end,
      title,
      ...(field("상태") ? { status: field("상태") } : {}),
      ...(field("시행일자") ? { effectiveDate: field("시행일자") } : {}),
    });
    index = closing;
  }

  if (starts.length === 0) {
    const title = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim()
      ?? name.replace(/\.md$/iu, "");
    return [{
      title,
      offset: 0,
      endOffset: content.length,
      excerpt: content.slice(0, 320).replace(/\s+/gu, " ").trim(),
    }];
  }

  const indexed = starts.map((entry, index) => {
    const endOffset = starts[index + 1]?.offset ?? content.length;
    const body = content.slice(entry.bodyOffset, endOffset);
    const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
    const excerpt = (heading ? `${heading} · ` : "")
      + body.replace(/^---\s*$/gmu, " ").replace(/^#{1,6}\s*/gmu, "")
        .replace(/[\s#*_`>-]+/gu, " ").trim().slice(0, 320);
    return {
      title: entry.title,
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.effectiveDate ? { effectiveDate: entry.effectiveDate } : {}),
      offset: entry.offset,
      endOffset,
      excerpt,
    };
  });
  const unique: LegalWikiEntry[] = [];
  const seen = new Set<string>();
  for (const entry of indexed) {
    const body = content
      .slice(entry.offset, entry.endOffset)
      .replace(/^---\s*$/gmu, "")
      .trim()
      .normalize("NFC");
    const signature = `${entry.title}\0${entry.status ?? ""}\0${entry.effectiveDate ?? ""}\0${body}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(entry);
  }
  return unique;
}

async function readPageTitle(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
    if (!frontmatter) return undefined;
    const value = /^제목:\s*(.+)$/mu.exec(frontmatter)?.[1]
      ?? /^title:\s*(.+)$/mu.exec(frontmatter)?.[1];
    return value ? decodeFrontmatterScalar(value) : undefined;
  } finally {
    await handle.close();
  }
}

function decodeFrontmatterScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/gu, "'");
  if (value.startsWith('"') && value.endsWith('"'))
    return value
      .slice(1, -1)
      .replace(/\\u([\da-f]{4})/giu, (_match, code: string) =>
        String.fromCharCode(Number.parseInt(code, 16)),
      )
      .replace(/\\U([\da-f]{8})/giu, (match, code: string) => {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : match;
      });
  return value;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
