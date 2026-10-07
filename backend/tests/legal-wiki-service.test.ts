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
    await writeFile(path.join(root, "notes.txt"), "not a Wiki page", "utf8");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "hidden.md"), "nested", "utf8");
    const service = new LegalWikiService(root);

    assert.deepEqual(await service.list(), [
      { name: "민법 핵심.md", title: "민법 핵심", bytes: 25 },
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
