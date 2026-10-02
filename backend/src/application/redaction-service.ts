import type { FileStorage, ManagedFile } from '../domain/managed-file.js';
import PizZip from 'pizzip';
import { badRequest } from '../shared/app-error.js';
import { findDocxXmlTextMatches, replaceDocxXmlText } from './docx-xml.js';
import { DocumentContentService } from './document-content-service.js';
import { DocumentService } from './document-service.js';

export type RedactionRule = 'email' | 'phone' | 'residentId';
const PATTERNS: Record<RedactionRule, RegExp> = {
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  phone: /(?:\+82[- ]?)?0(?:10|2|[3-9]\d?)[- ]?\d{3,4}[- ]?\d{4}/g,
  residentId: /\b\d{6}[- ]?[1-4]\d{6}\b/g,
};
export class RedactionService {
  constructor(private readonly files: FileStorage) {}
  async redact(input: { fileId: string; outputName: string; rules: RedactionRule[] }): Promise<{ file: ManagedFile; replacements: number }> {
    const source = await this.files.read(input.fileId);
    if (!input.rules.length || input.rules.some(rule => !Object.hasOwn(PATTERNS, rule))) throw badRequest('at least one supported redaction rule is required');
    if (!source.metadata.name.toLowerCase().endsWith('.docx')) {
      const extracted = await new DocumentContentService(this.files).extract(input.fileId);
      let text = extracted.text;
      let replacements = 0;
      for (const rule of [...new Set(input.rules)]) text = text.replace(PATTERNS[rule], value => { replacements++; return `[REDACTED ${rule.toUpperCase()}]`; });
      const file = await new DocumentService(this.files).create({ outputName: input.outputName, title: `Redacted: ${source.metadata.name}`, paragraphs: text.split(/\n+/).filter(Boolean) });
      return { file, replacements };
    }
    let zip: PizZip;
    try { zip = new PizZip(Buffer.from(source.content)); }
    catch { throw badRequest('invalid DOCX archive'); }
    const xmlFiles = Object.keys(zip.files).filter(name => !zip.files[name]?.dir && name.toLowerCase().endsWith('.xml'));
    let replacements = 0;
    const detected: Array<{ value: string; rule: RedactionRule }> = [];
    for (const name of xmlFiles) {
      const file = zip.file(name);
      if (!file) continue;
      let xml = file.asText();
      for (const rule of [...new Set(input.rules)]) {
        const values = findDocxXmlTextMatches(xml, PATTERNS[rule]);
        for (const value of new Set(values)) {
          detected.push({ value, rule });
          const result = replaceDocxXmlText(xml, { find: value, replace: `[REDACTED ${rule.toUpperCase()}]` });
          replacements += result.count;
          xml = result.value;
        }
      }
      zip.file(name, xml);
    }
    for (const { value } of detected) {
      if (xmlFiles.some(name => zip.file(name)?.asText().includes(value))) throw badRequest('redaction could not remove all detected sensitive text; no output was saved');
    }
    const outputName = input.outputName.trim();
    if (!outputName) throw badRequest('outputName is required');
    const safeName = outputName.toLowerCase().endsWith('.docx') ? outputName : `${outputName}.docx`;
    const file = await this.files.save({
      name: safeName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: zip.generate({ type: 'nodebuffer' }),
    });
    return { file, replacements };
  }
}
