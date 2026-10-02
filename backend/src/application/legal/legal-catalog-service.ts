import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { unavailable } from "../../shared/app-error.js";

const CATALOG_FILES = [
  "index.md",
  "laws.md",
  "precedents.md",
  "lexical-index.md",
  "vector-index.md",
  "ontology.md",
  "graph-index.md",
] as const;

export type LegalCatalogEntry = { name: string; content: string };

export class LegalCatalogService {
  constructor(private readonly root: string) {}

  async list(): Promise<LegalCatalogEntry[]> {
    try {
      const root = await realpath(this.root);
      const entries: LegalCatalogEntry[] = [];
      for (const name of CATALOG_FILES) {
        const file = await realpath(path.join(root, name));
        if (!file.startsWith(`${root}${path.sep}`)) continue;
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.size > 16_384) continue;
        entries.push({ name, content: await readFile(file, "utf8") });
      }
      if (entries.length === 0) throw new Error("catalog is empty");
      return entries;
    } catch {
      throw unavailable(
        "OKF 카탈로그를 읽지 못했습니다. 카탈로그 번들의 준비 상태를 확인하세요.",
      );
    }
  }
}
