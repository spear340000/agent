import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument } from "pdf-lib";
import { ApiRouter } from "../src/api/router.js";
import { ApiAuthenticator } from "../src/api/authentication.js";
import { createApiServer } from "../src/api/server.js";
import { LocalFileStorage } from "../src/infrastructure/storage/local-file-storage.js";
import { FileService } from "../src/application/file-service.js";
import { DocumentService } from "../src/application/document-service.js";
import { SpreadsheetService } from "../src/application/spreadsheet-service.js";
import { PdfService } from "../src/application/pdf-service.js";
import {
  markdownDocumentHtml,
  stripMarkdownInline,
} from "../src/application/markdown-export.js";
import { LegalWikiService } from "../src/application/legal/legal-wiki-service.js";

test("PDF tables allocate page width by the amount of content in each column", () => {
  const html = markdownDocumentHtml(
    "| 번호 | 확인할 내용 | 참고 자료 |\n| --- | --- | --- |\n| 1 | 실제 처리 목적과 이용 범위를 확인합니다. | 계약서 |",
    "표 레이아웃",
  );
  const widths = [...html.matchAll(/<col style="width:([\d.]+)%">/gu)].map(
    (match) => Number(match[1]),
  );
  assert.equal(widths.length, 3);
  assert.ok(widths[0]! <= 16);
  assert.ok(widths[0]! < widths[1]!);
  assert.ok(widths[2]! < widths[1]!);
  assert.ok(Math.abs(widths.reduce((total, width) => total + width, 0) - 100) < 1);
});

test("Markdown links keep labels without exposing non-URL destinations", () => {
  const markdown =
    "[W1](알티케이뉴스 기사) [공식 자료](https://example.org/source) [위험](javascript:alert)";
  const html = markdownDocumentHtml(markdown, "출처");

  assert.equal(stripMarkdownInline("[W1](알티케이뉴스 기사)"), "W1");
  assert.match(html, /W1/);
  assert.match(html, /<a href="https:\/\/example\.org\/source">공식 자료<\/a>/);
  assert.doesNotMatch(html, /\]\(/);
  assert.doesNotMatch(html, /javascript:/i);
});

test("PDF table columns stay positive and sum to one page for wide tables", () => {
  const headers = Array.from({ length: 50 }, (_, index) => `열 ${index + 1}`);
  const row = headers.map((_, index) =>
    index === 0 ? "긴 설명 ".repeat(80) : "값",
  );
  const markdown = [
    headers,
    headers.map(() => "---"),
    row,
  ]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
  const html = markdownDocumentHtml(markdown, "넓은 표");
  const widths = [...html.matchAll(/<col style="width:([\d.-]+)%">/gu)].map(
    (match) => Number(match[1]),
  );

  assert.equal(widths.length, headers.length);
  assert.ok(widths.every((width) => Number.isFinite(width) && width > 0));
  assert.ok(Math.abs(widths.reduce((total, width) => total + width, 0) - 100) < 1);
});

test("file library, Korean downloads, new spreadsheets and PDF inspection work over HTTP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workfolio-office-api-"));
  const storage = new LocalFileStorage(root);
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot);
  await writeFile(
    path.join(wikiRoot, "privacy-law-core.md"),
    "# 개인정보 보호 핵심\n\n읽기 전용 자료입니다.",
    "utf8",
  );
  const router = new ApiRouter({
    files: new FileService(storage),
    documents: new DocumentService(storage),
    spreadsheets: new SpreadsheetService(storage),
    pdfs: new PdfService(storage, async (html) => {
      assert.match(html, /<table>/);
      assert.match(html, /카카오/);
      const report = await PDFDocument.create();
      report.addPage([595, 842]);
      return report.save();
    }),
    legalWiki: new LegalWikiService(wikiRoot),
    authenticator: new ApiAuthenticator(),
  } as never);
  const server = createApiServer(router);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (endpoint: string, input: unknown) =>
    fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  try {
    const wikiListResponse = await fetch(`${base}/api/legal/wiki`);
    assert.equal(wikiListResponse.status, 200);
    const wikiList = (await wikiListResponse.json()) as {
      items: Array<{ name: string; title: string; bytes: number }>;
    };
    assert.deepEqual(wikiList.items, [
      {
        name: "privacy-law-core.md",
        title: "privacy law core",
        bytes: Buffer.byteLength(
          "# 개인정보 보호 핵심\n\n읽기 전용 자료입니다.",
          "utf8",
        ),
      },
    ]);
    const wikiPageResponse = await fetch(
      `${base}/api/legal/wiki/page?name=privacy-law-core.md&offset=0&limit=12`,
    );
    assert.equal(wikiPageResponse.status, 200);
    assert.deepEqual(await wikiPageResponse.json(), {
      name: "privacy-law-core.md",
      content: "# 개인정보 보호 핵심",
      offset: 0,
      nextOffset: 12,
      totalCharacters: "# 개인정보 보호 핵심\n\n읽기 전용 자료입니다.".length,
      hasMore: true,
    });
    const created = await post("/api/spreadsheets/create", {
      outputName: "예산",
      operations: [
        { kind: "addSheet", name: "예산" },
        { kind: "setCell", sheet: "예산", cell: "A1", value: 15000 },
      ],
    });
    assert.equal(created.status, 201);
    const { file } = (await created.json()) as {
      file: { id: string; name: string };
    };
    assert.equal(file.name, "예산.xlsx");
    const inspect = await post("/api/spreadsheets/inspect", {
      fileId: file.id,
      sheet: "예산",
      range: "A1",
    });
    assert.deepEqual(((await inspect.json()) as { cells: unknown[] }).cells, [
      { address: "A1", value: 15000 },
    ]);
    const download = await fetch(`${base}/api/files/${file.id}/content`);
    assert.equal(download.status, 200);
    assert.ok(
      download.headers
        .get("content-disposition")
        ?.includes("filename*=UTF-8''%EC%98%88%EC%82%B0.xlsx"),
    );
    assert.ok((await download.arrayBuffer()).byteLength > 1000);
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    const saved = await storage.save({
      name: "페이지.pdf",
      mimeType: "application/pdf",
      content: await pdf.save(),
    });
    const inspected = await post("/api/pdfs/inspect", { fileId: saved.id });
    assert.equal(inspected.status, 200);
    assert.deepEqual(((await inspected.json()) as { pages: unknown[] }).pages, [
      { number: 1, width: 300, height: 400, rotation: 0 },
    ]);
    const library = await fetch(`${base}/api/files?limit=1`);
    assert.equal(library.status, 200);
    const first = (await library.json()) as {
      items: Array<{ id: string }>;
      nextCursor?: string;
    };
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const next = await fetch(
      `${base}/api/files?limit=1&cursor=${first.nextCursor}`,
    );
    const second = (await next.json()) as { items: Array<{ id: string }> };
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]!.id, first.items[0]!.id);
    const invalid = await fetch(`${base}/api/files?limit=100000`);
    assert.equal(invalid.status, 400);
    const reportMarkdown =
      "# 카카오 자료 검토\n\n요약 문장입니다.\n\n| 쟁점 | 확인 내용 |\n| --- | --- |\n| 위탁 | 계약과 처리 범위를 확인 |\n| 제공 | 제3자 제공 여부를 확인 |";
    const workbookResponse = await post("/api/documents/export", {
      outputName: "카카오 검토",
      format: "xlsx",
      markdown: reportMarkdown,
    });
    assert.equal(workbookResponse.status, 201);
    const { file: workbookFile } = (await workbookResponse.json()) as {
      file: { id: string; name: string };
    };
    assert.equal(workbookFile.name, "카카오 검토.xlsx");
    const workbookPackage = await storage.read(workbookFile.id);
    const workbookZip = new PizZip(workbookPackage.content);
    const sheetXml = workbookZip.file("xl/worksheets/sheet1.xml")?.asText();
    assert.ok(sheetXml, "report worksheet metadata should be present");
    assert.match(sheetXml, /<tableParts count="1"/);
    const reportTableXml = workbookZip.file("xl/tables/table1.xml")?.asText();
    assert.ok(reportTableXml, "Markdown tables remain native Excel tables");
    assert.match(reportTableXml, /ref="A3:B5"/);
    assert.match(reportTableXml, /<autoFilter ref="A3:B5"/);
    assert.match(reportTableXml, /tableStyleInfo name="TableStyleLight1"/);
    assert.doesNotMatch(
      reportTableXml,
      /totalsRow(?:Shown|Count|Label|Function)/,
      "a Markdown table must not carry implicit totals-row metadata",
    );
    const styledWorkbook = new ExcelJS.Workbook();
    await styledWorkbook.xlsx.load(Buffer.from(workbookPackage.content));
    const styledReport = styledWorkbook.getWorksheet("보고서");
    assert.equal(styledReport?.getCell("A1").font.size, 16);
    assert.equal(styledReport?.getCell("A1").font.name, "맑은 고딕");
    assert.equal(styledReport?.getCell("B1").isMerged, true);
    assert.ok((styledReport?.getColumn(2).width ?? Infinity) <= 44);
    assert.equal(styledReport?.getCell("A3").font.bold, true);
    assert.notEqual(
      styledReport?.getCell("A4").font.bold,
      true,
      "the last data row must not inherit totals-row emphasis",
    );
    assert.equal(styledReport?.getRow(4).height, 24);
    assert.notEqual(styledReport?.getCell("A5").font.bold, true);
    assert.deepEqual(
      styledReport?.getCell("A5").fill,
      { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7F4" } },
    );
    const workbookStructure = await post("/api/spreadsheets/inspect", {
      fileId: workbookFile.id,
    });
    const workbookInfo = (await workbookStructure.json()) as {
      sheets: Array<{ name: string; columns: number }>;
    };
    assert.deepEqual(
      workbookInfo.sheets.map((sheet) => sheet.name),
      ["보고서"],
    );
    assert.equal(workbookInfo.sheets[0]?.columns, 2);
    const reportTable = await post("/api/spreadsheets/inspect", {
      fileId: workbookFile.id,
      sheet: "보고서",
      range: "A3:B5",
    });
    assert.equal(reportTable.status, 200);
    assert.deepEqual(
      (
        (await reportTable.json()) as {
          cells: Array<{ address: string; value: unknown }>;
        }
      ).cells,
      [
        { address: "A3", value: "쟁점" },
        { address: "B3", value: "확인 내용" },
        { address: "A4", value: "위탁" },
        { address: "B4", value: "계약과 처리 범위를 확인" },
        { address: "A5", value: "제공" },
        { address: "B5", value: "제3자 제공 여부를 확인" },
      ],
    );
    const proseWorkbookResponse = await post("/api/documents/export", {
      outputName: "요약",
      format: "xlsx",
      markdown:
        "# 요약\n\n> 안내 문장입니다.\n\n## 답변\n\n**핵심 판단**\n\n첫 번째 문단의 **중요** 문장입니다. [W1](알티케이뉴스 기사).\n\n두 번째 문단입니다.",
    });
    assert.equal(proseWorkbookResponse.status, 201);
    const { file: proseWorkbookFile } =
      (await proseWorkbookResponse.json()) as { file: { id: string } };
    const proseWorkbookStructure = await post("/api/spreadsheets/inspect", {
      fileId: proseWorkbookFile.id,
    });
    const proseWorkbookInfo = (await proseWorkbookStructure.json()) as {
      sheets: Array<{ columns: number }>;
    };
    assert.equal(proseWorkbookInfo.sheets[0]?.columns, 1);
    const proseWorkbookBytes = await storage.read(proseWorkbookFile.id);
    const proseWorkbook = new ExcelJS.Workbook();
    await proseWorkbook.xlsx.load(Buffer.from(proseWorkbookBytes.content));
    const proseSheet = proseWorkbook.getWorksheet("보고서");
    assert.equal(proseSheet?.getCell("A2").font.name, "맑은 고딕");
    assert.equal(proseSheet?.getCell("A2").value, "안내 문장입니다.");
    assert.equal(proseSheet?.getCell("A3").value, "답변");
    assert.equal(proseSheet?.getCell("A4").value, "핵심 판단");
    assert.equal(proseSheet?.getCell("A4").font.bold, true);
    const inlineFormattedValue = proseSheet?.getCell("A5").value as {
      richText?: Array<{ text: string; font?: { bold?: boolean } }>;
    };
    assert.ok(Array.isArray(inlineFormattedValue?.richText));
    assert.equal(
      inlineFormattedValue.richText.map((run) => run.text).join(""),
      "첫 번째 문단의 중요 문장입니다. W1.",
    );
    assert.ok(
      inlineFormattedValue.richText.some(
        (run) => run.text === "중요" && run.font?.bold === true,
      ),
    );
    assert.equal(proseSheet?.getCell("A6").value, "두 번째 문단입니다.");
    assert.equal(proseSheet?.getColumn(1).width, 82);
    assert.equal(proseSheet?.getCell("A2").isMerged, false);
    assert.equal(proseSheet?.getCell("A3").isMerged, false);
    assert.equal(proseSheet?.getCell("A5").isMerged, false);
    assert.equal(proseSheet?.getTables().length, 0);
    const widthSampleResponse = await post("/api/documents/export", {
      outputName: "열 너비 검토",
      format: "xlsx",
      markdown:
        "# 개인정보 처리 위탁 검토\n\n| 판단 항목 | 확인할 내용 | 참고 자료 |\n| --- | --- | --- |\n| 지시·감독 | 위탁 범위가 계약에 특정됐는지 확인 | 업무 지침 |\n| 처리 기록 | 수탁자 접근 로그와 실제 처리 범위를 계약 내용과 대조합니다 | 접근 기록 |",
    });
    const { file: widthSampleFile } = (await widthSampleResponse.json()) as {
      file: { id: string };
    };
    const widthSampleBytes = await storage.read(widthSampleFile.id);
    const widthSampleWorkbook = new ExcelJS.Workbook();
    await widthSampleWorkbook.xlsx.load(Buffer.from(widthSampleBytes.content));
    const widthSampleSheet = widthSampleWorkbook.getWorksheet("보고서");
    const firstColumnWidth = widthSampleSheet?.getColumn(1).width ?? 0;
    const secondColumnWidth = widthSampleSheet?.getColumn(2).width ?? Infinity;
    const thirdColumnWidth = widthSampleSheet?.getColumn(3).width ?? 0;
    assert.equal(firstColumnWidth, 16);
    assert.equal(secondColumnWidth, 30);
    assert.equal(thirdColumnWidth, 16);
    assert.equal(widthSampleSheet?.getRow(3).height, 24);
    assert.equal(widthSampleSheet?.getRow(4).height, 40);
    const multipleTablesResponse = await post("/api/documents/export", {
      outputName: "여러 표",
      format: "xlsx",
      markdown:
        "# 여러 표\n\n| 항목 | 결과 |\n| --- | --- |\n| 첫 표 | 값 1 |\n\n설명 문장입니다.\n\n| 항목 | 결과 |\n| --- | --- |\n| 둘째 표 | 값 2 |",
    });
    assert.equal(multipleTablesResponse.status, 201);
    const { file: multipleTablesFile } =
      (await multipleTablesResponse.json()) as { file: { id: string } };
    const multipleTablesStored = await storage.read(multipleTablesFile.id);
    const multipleTablesWorkbook = new ExcelJS.Workbook();
    await multipleTablesWorkbook.xlsx.load(
      Buffer.from(multipleTablesStored.content),
    );
    const multipleTablesZip = new PizZip(
      Buffer.from(multipleTablesStored.content),
    );
    const expectedTableRanges = ["A2:B3", "A6:B7"];
    for (const [index, tableName] of ["table1.xml", "table2.xml"].entries()) {
      const tableXml = multipleTablesZip
        .file(`xl/tables/${tableName}`)
        ?.asText();
      assert.ok(tableXml, `${tableName} should retain its own native filter`);
      assert.match(tableXml, new RegExp(`ref="${expectedTableRanges[index]}"`));
      assert.match(
        tableXml,
        new RegExp(`<autoFilter ref="${expectedTableRanges[index]}"`),
      );
      assert.doesNotMatch(tableXml, /totalsRow(?:Shown|Count|Label|Function)/);
    }
    const pdfResponse = await post("/api/documents/export", {
      outputName: "카카오 검토",
      format: "pdf",
      markdown: reportMarkdown,
    });
    assert.equal(pdfResponse.status, 201);
    const { file: pdfFile } = (await pdfResponse.json()) as {
      file: { id: string; name: string };
    };
    assert.equal(pdfFile.name, "카카오 검토.pdf");
    const pdfDownload = await fetch(`${base}/api/files/${pdfFile.id}/content`);
    assert.equal(pdfDownload.status, 200);
    assert.ok((await pdfDownload.arrayBuffer()).byteLength > 500);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
