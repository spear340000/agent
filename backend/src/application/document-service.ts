import { Document, Packer, Paragraph, TextRun } from 'docx';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type { FileStorage, ManagedFile } from '../domain/managed-file.js';
import { badRequest } from '../shared/app-error.js';
import { replaceDocxXmlText } from './docx-xml.js';
import { markdownToDocxChildren } from './markdown-docx.js';

export class DocumentService {
  constructor(private readonly files: FileStorage) {}
  async create(input: { outputName: string; title: string; paragraphs: string[] }): Promise<ManagedFile> {
    if (!input.title.trim()) throw badRequest('title is required');
    const document = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: input.title, bold: true, size: 32 })] }), ...input.paragraphs.filter(Boolean).map(text => new Paragraph(text))] }] });
    return this.files.save({ name: this.docxName(input.outputName), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from(await Packer.toBuffer(document)) });
  }
  async createMarkdownReport(input: { outputName: string; markdown: string }): Promise<ManagedFile> {
    const lines = input.markdown.replace(/\r\n?/g, '\n').split('\n');
    const firstContentLine = lines.findIndex(line => line.trim());
    const title = lines[firstContentLine]?.replace(/^#\s+/, '').trim() || 'Research report';
    const body = lines.filter((_, index) => index !== firstContentLine).join('\n');
    const children = markdownToDocxChildren(body);
    const document = new Document({
      numbering: { config: [{ reference: 'report-numbering', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }, { reference: 'report-bullets', levels: [{ level: 0, format: 'bullet', text: '•', alignment: 'left' }] }] },
      sections: [{
        properties: {
          page: {
            size: { width: 11_906, height: 16_838 },
            margin: { top: 1_200, right: 1_080, bottom: 1_200, left: 1_080 },
          },
        },
        children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 34 })] }), ...children],
      }],
    });
    return this.files.save({ name: this.docxName(input.outputName), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from(await Packer.toBuffer(document)) });
  }
  async fillTemplate(input: { fileId: string; outputName: string; variables: Record<string, string | number | boolean> }): Promise<ManagedFile> {
    const source = await this.files.read(input.fileId);
    if (!source.metadata.name.toLowerCase().endsWith('.docx')) throw badRequest('only .docx files are supported');
    let template: Docxtemplater;
    try { template = new Docxtemplater(new PizZip(source.content), { paragraphLoop: true, linebreaks: true }); }
    catch { throw badRequest('invalid DOCX template'); }
    let fullText: string;
    try { fullText = template.getFullText(); }
    catch { throw badRequest('invalid DOCX template'); }
    const placeholders = new Set<string>();
    for (const [, expression = ''] of fullText.matchAll(/\{([^{}]+)\}/g)) {
      const tag = expression.replace(/^[#$/^@]/, '').trim();
      if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(tag)) throw badRequest('template contains unsupported tag syntax');
      placeholders.add(tag);
    }
    const keys = Object.keys(input.variables);
    const missing = [...placeholders].filter(key => !Object.hasOwn(input.variables, key));
    const unused = keys.filter(key => !placeholders.has(key));
    if (missing.length) throw badRequest(`missing template variables: ${missing.join(', ')}`);
    if (unused.length) throw badRequest(`unused template variables: ${unused.join(', ')}`);
    try { template.render(input.variables); }
    catch { throw badRequest('DOCX template variables could not be rendered'); }
    return this.files.save({ name: this.docxName(input.outputName), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: template.getZip().generate({ type: 'nodebuffer' }) });
  }
  async replaceText(input: { fileId: string; outputName: string; replacements: Array<{ find: string; replace: string }> }): Promise<{ file: ManagedFile; replacements: number; missing: string[] }> {
    if (!input.replacements.length) throw badRequest('at least one replacement is required');
    const source = await this.files.read(input.fileId);
    if (!source.metadata.name.toLowerCase().endsWith('.docx')) throw badRequest('only .docx files are supported');
    const zip = new PizZip(source.content); let count = 0;
    const replacementCounts = input.replacements.map(() => 0);
    const xmlFiles = Object.keys(zip.files).filter(name => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name) || /^docProps\/[^/]+\.xml$/.test(name));
    for (const name of xmlFiles) {
      const file = zip.file(name); if (!file) continue; let xml = file.asText();
      for (const [index, replacement] of input.replacements.entries()) {
        if (!replacement.find) throw badRequest('replacement find text is required');
        const result = replaceDocxXmlText(xml, replacement);
        count += result.count;
        replacementCounts[index] = replacementCounts[index]! + result.count;
        xml = result.value;
      }
      zip.file(name, xml);
    }
    const missing = input.replacements.filter((_, index) => replacementCounts[index] === 0).map(replacement => replacement.find);
    return { file: await this.files.save({ name: this.docxName(input.outputName), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: zip.generate({ type: 'nodebuffer' }) }), replacements: count, missing };
  }
  private docxName(name: string): string { const trimmed = name.trim(); if (!trimmed) throw badRequest('outputName is required'); return trimmed.toLowerCase().endsWith('.docx') ? trimmed : `${trimmed}.docx`; }
}
