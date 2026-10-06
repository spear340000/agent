import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LegalWikiService } from "../src/application/legal/legal-wiki-service.js";

test("read-only Wiki browsing lists Markdown pages and reads bounded Unicode-safe sections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workfolio-legal-wiki-"));
  try {
    await writeFile(path.join(root, "민법 핵심.md"), "가나다🙂라마바사", "utf8");
    await writeFile(path.join(root, "civil-law-core.md"), "---\ntype: Law\ntitle: 민법 핵심 조문 검색집\nstatus: active\n---\n# 민법 핵심 조문 검색집\n", "utf8");
    await writeFile(path.join(root, "escaped-title.md"), '---\ntype: Document\ntitle: "\\uBBFC\\uBC95"\n---\n# 자료\n', "utf8");
    await writeFile(path.join(root, "notes.txt"), "not a Wiki page", "utf8");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "hidden.md"), "nested", "utf8");
    const service = new LegalWikiService(root);

    assert.deepEqual(await service.list(), [
      { name: "민법 핵심.md", title: "민법 핵심", bytes: 25 },
      { name: "civil-law-core.md", title: "민법 핵심 조문 검색집", bytes: 104 },
      { name: "escaped-title.md", title: "민법", bytes: 54 },
    ]);

    const first = await service.readPage("민법 핵심.md", 0, 4);
    assert.equal(first.content, "가나다🙂");
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 5);
    assert.equal(first.totalCharacters, 9);
    assert.equal(first.hasMore, true);

    const next = await service.readPage("민법 핵심.md", first.nextOffset, 4);
    assert.equal(next.content, "라마바사");
    assert.equal(next.hasMore, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wiki page reads reject traversal, unknown files, and unbounded ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workfolio-legal-wiki-"));
  try {
    await writeFile(path.join(root, "법률.md"), "원문", "utf8");
    const service = new LegalWikiService(root);
    await assert.rejects(service.readPage("../secrets.md", 0, 10), /invalid Wiki page name/i);
    await assert.rejects(service.readPage("missing.md", 0, 10), /Wiki page not found/i);
    await assert.rejects(service.readPage("법률.md", 0, 30_001), /limit must be between/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consolidated Wiki corpora expose paged law records with original text offsets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workfolio-legal-wiki-index-"));
  try {
    const content = [
      "---",
      "type: Document",
      'title: "법률"',
      "---",
      "# 법률",
      "---",
      "제목: 민법",
      "상태: 시행",
      "시행일자: 2024-07-03",
      "---",
      "# 민법",
      "##### 제1조 (법원)",
      "민사에 관하여 법률에 규정이 없으면 관습법에 따른다.",
      "---",
      "제목: 상법",
      "상태: 시행",
      "시행일자: 2025-01-01",
      "---",
      "# 상법",
      "##### 제1조 (상사적용법규)",
      "상사에 관하여 본 법에 규정이 없으면 상관습법에 따른다.",
      "---",
      "제목: 민법",
      "상태: 시행",
      "시행일자: 2024-07-03",
      "---",
      "# 민법",
      "##### 제1조 (법원)",
      "민사에 관하여 법률에 규정이 없으면 관습법에 따른다.",
      "",
    ].join("\n");
    await writeFile(path.join(root, "법률.md"), content, "utf8");
    const service = new LegalWikiService(root);

    const firstPage = await service.listEntries("법률.md", "", 0, 1);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(firstPage.items.map(({ title, status, effectiveDate }) => ({ title, status, effectiveDate })), [
      { title: "민법", status: "시행", effectiveDate: "2024-07-03" },
    ]);
    const originalText = await service.readPage(
      "법률.md",
      firstPage.items[0]!.offset,
      120,
    );
    assert.match(originalText.content, /# 민법/);
    assert.match(originalText.content, /제1조 \(법원\)/);
    assert.doesNotMatch(originalText.content, /# 상법/);

    const filtered = await service.listEntries("법률.md", "상법", 0, 10);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0]?.title, "상법");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
