import { realpath, readdir, readFile, stat } from "node:fs/promises";
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

export class LegalWikiService {
  constructor(private readonly wikiRoot: string) {}

  async list(): Promise<LegalWikiPageSummary[]> {
    const root = await this.resolveRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const pages: LegalWikiPageSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md"))
        continue;
      const metadata = await stat(path.join(root, entry.name));
      pages.push({
        name: entry.name,
        title: entry.name.replace(/\.md$/iu, "").replace(/[-_]+/gu, " "),
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

  private async resolveRoot(): Promise<string> {
    try {
      return await realpath(this.wikiRoot);
    } catch {
      throw unavailable(
        "법률 Wiki 폴더를 읽을 수 없습니다. 읽기 전용 Wiki 경로를 확인하세요.",
      );
    }
  }
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
