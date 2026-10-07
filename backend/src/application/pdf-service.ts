import { PDFDocument, degrees } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import type { FileStorage, ManagedFile } from "../domain/managed-file.js";
import { badRequest, unavailable } from "../shared/app-error.js";
import { markdownDocumentHtml } from "./markdown-export.js";

const MAX_PDF_PAGES = 2_000;
const MAX_MERGE_FILES = 100;
const MAX_PDF_THUMBNAIL_BATCH = 12;

export class PdfService {
  constructor(
    private readonly files: FileStorage,
    private readonly renderHtmlToPdf?: (html: string) => Promise<Uint8Array>,
  ) {}

  async createMarkdownReport(input: {
    outputName: string;
    markdown: string;
  }): Promise<ManagedFile> {
    const title = input.outputName.trim();
    if (!title) throw badRequest("outputName is required");
    if (!input.markdown.trim() || input.markdown.length > 200_000)
      throw badRequest("markdown must contain at most 200000 characters");
    if (!this.renderHtmlToPdf)
      throw unavailable(
        "PDF rendering is unavailable because the headless browser is not configured",
      );
    const rendered = Buffer.from(
      await this.renderHtmlToPdf(markdownDocumentHtml(input.markdown, title)),
    );
    if (rendered.length > 40 * 1024 * 1024)
      throw badRequest("generated PDF exceeds the 40 MiB limit");
    await this.loadPdf(rendered);
    return this.savePdf(title, rendered);
  }

  async inspect(fileId: string): Promise<{
    fileId: string;
    pageCount: number;
    pages: Array<{
      number: number;
      width: number;
      height: number;
      rotation: number;
    }>;
  }> {
    const file = await this.files.read(fileId);
    this.assertPdf(file.metadata.name);
    const document = await this.loadPdf(file.content);
    return {
      fileId,
      pageCount: document.getPageCount(),
      pages: document.getPages().map((page, index) => ({
        number: index + 1,
        ...page.getSize(),
        rotation: page.getRotation().angle,
      })),
    };
  }

  async renderThumbnails(input: {
    fileId: string;
    pageNumbers: number[];
  }): Promise<{
    pageCount: number;
    pages: Array<{
      pageNumber: number;
      width: number;
      height: number;
      dataBase64: string;
    }>;
  }> {
    const { pageNumbers } = input;
    if (
      pageNumbers.length < 1 ||
      pageNumbers.length > MAX_PDF_THUMBNAIL_BATCH ||
      !pageNumbers.every(
        (pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0,
      ) ||
      new Set(pageNumbers).size !== pageNumbers.length
    )
      throw badRequest(
        `pageNumbers must contain 1 to ${MAX_PDF_THUMBNAIL_BATCH} unique positive page numbers`,
      );

    const file = await this.files.read(input.fileId);
    this.assertPdf(file.metadata.name);
    const document = await this.loadPdf(file.content);
    const pageCount = document.getPageCount();
    if (!pageNumbers.every((pageNumber) => pageNumber <= pageCount))
      throw badRequest("pageNumbers contains an invalid page");

    const parser = new PDFParse({ data: Buffer.from(file.content) });
    try {
      const rendered = await parser.getScreenshot({
        partial: pageNumbers,
        desiredWidth: 180,
        imageBuffer: true,
        imageDataUrl: false,
      });
      if (rendered.pages.length !== pageNumbers.length)
        throw badRequest("one or more PDF pages could not be rendered");
      return {
        pageCount,
        pages: rendered.pages.map((page) => ({
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
          dataBase64: Buffer.from(page.data).toString("base64"),
        })),
      };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      throw badRequest("PDF page thumbnails could not be rendered");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  async merge(input: {
    fileIds: string[];
    outputName: string;
  }): Promise<ManagedFile> {
    if (input.fileIds.length < 2 || input.fileIds.length > MAX_MERGE_FILES)
      throw badRequest(
        `merge requires between 2 and ${MAX_MERGE_FILES} PDF fileIds`,
      );
    const output = await PDFDocument.create();
    let totalPages = 0;
    for (const id of input.fileIds) {
      const sourceFile = await this.files.read(id);
      this.assertPdf(sourceFile.metadata.name);
      const source = await this.loadPdf(sourceFile.content);
      totalPages += source.getPageCount();
      if (totalPages > MAX_PDF_PAGES)
        throw badRequest(
          `PDF operations are limited to ${MAX_PDF_PAGES} pages`,
        );
      const pages = await output.copyPages(source, source.getPageIndices());
      pages.forEach((page) => output.addPage(page));
    }
    return this.savePdf(input.outputName, await output.save());
  }

  async split(input: {
    fileId: string;
    pageNumbers: number[];
    outputPrefix: string;
  }): Promise<ManagedFile[]> {
    if (!input.pageNumbers.length) throw badRequest("pageNumbers is required");
    if (!input.outputPrefix.trim())
      throw badRequest("outputPrefix is required");
    const file = await this.files.read(input.fileId);
    this.assertPdf(file.metadata.name);
    const source = await this.loadPdf(file.content);
    const max = source.getPageCount();
    const pageNumbers = [...new Set(input.pageNumbers)];
    if (
      !pageNumbers.every(
        (page) => Number.isInteger(page) && page >= 1 && page <= max,
      )
    )
      throw badRequest("pageNumbers contains an invalid page");
    const contents: Array<{ name: string; content: Uint8Array }> = [];
    for (const pageNumber of pageNumbers) {
      const output = await PDFDocument.create();
      const [page] = await output.copyPages(source, [pageNumber - 1]);
      if (!page) throw badRequest(`page ${pageNumber} could not be copied`);
      output.addPage(page);
      contents.push({
        name: `${input.outputPrefix}-${pageNumber}.pdf`,
        content: await output.save(),
      });
    }
    return Promise.all(
      contents.map((item) =>
        this.files.save({
          name: item.name,
          mimeType: "application/pdf",
          content: item.content,
        }),
      ),
    );
  }

  async edit(input: {
    fileId: string;
    outputName: string;
    operation: {
      kind: "reorder" | "removePages" | "rotatePages";
      pageNumbers: number[];
      degrees?: number;
    };
  }): Promise<ManagedFile> {
    if (
      !input.operation ||
      !["reorder", "removePages", "rotatePages"].includes(input.operation.kind)
    )
      throw badRequest("invalid PDF edit operation");
    if (!input.operation.pageNumbers.length)
      throw badRequest("pageNumbers is required");
    const file = await this.files.read(input.fileId);
    this.assertPdf(file.metadata.name);
    const source = await this.loadPdf(file.content);
    const pageCount = source.getPageCount();
    const requested = input.operation.pageNumbers;
    if (
      !requested.every(
        (page) => Number.isInteger(page) && page >= 1 && page <= pageCount,
      )
    )
      throw badRequest("pageNumbers contains an invalid page");
    const pages = [...new Set(requested)];
    if (
      input.operation.kind !== "removePages" &&
      pages.length !== requested.length
    )
      throw badRequest("pageNumbers must not contain duplicates");
    if (input.operation.kind === "rotatePages") {
      const rotation = input.operation.degrees;
      if (![90, 180, 270].includes(rotation ?? 0))
        throw badRequest("degrees must be 90, 180, or 270");
      for (const number of pages) {
        const page = source.getPage(number - 1);
        page.setRotation(degrees((page.getRotation().angle + rotation!) % 360));
      }
      return this.savePdf(input.outputName, await source.save());
    }
    let selected: number[];
    if (input.operation.kind === "reorder") {
      if (pages.length !== pageCount || new Set(pages).size !== pageCount)
        throw badRequest("reorder must list every page exactly once");
      selected = pages;
    } else
      selected = source
        .getPageIndices()
        .map((index) => index + 1)
        .filter((number) => !new Set(pages).has(number));
    if (!selected.length) throw badRequest("edit would produce an empty PDF");
    const output = await PDFDocument.create();
    const copied = await output.copyPages(
      source,
      selected.map((number) => number - 1),
    );
    copied.forEach((page) => output.addPage(page));
    return this.savePdf(input.outputName, await output.save());
  }

  private async loadPdf(content: Uint8Array): Promise<PDFDocument> {
    try {
      const document = await PDFDocument.load(Buffer.from(content));
      if (
        document.getPageCount() < 1 ||
        document.getPageCount() > MAX_PDF_PAGES
      )
        throw badRequest(
          `PDF must contain between 1 and ${MAX_PDF_PAGES} pages`,
        );
      return document;
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      throw badRequest("invalid or encrypted PDF");
    }
  }

  private savePdf(
    outputName: string,
    content: Uint8Array,
  ): Promise<ManagedFile> {
    return this.files.save({
      name: this.name(outputName),
      mimeType: "application/pdf",
      content,
    });
  }

  private assertPdf(name: string): void {
    if (!name.toLowerCase().endsWith(".pdf"))
      throw badRequest("only .pdf files are supported");
  }
  private name(value: string): string {
    const name = value.trim();
    if (!name) throw badRequest("outputName is required");
    return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
  }
}
