import type { ModelProvider } from '../domain/model-provider.js';
import type { ManagedFile } from '../domain/managed-file.js';
import { badRequest } from '../shared/app-error.js';
import { DocumentContentService } from './document-content-service.js';
import { DocumentService } from './document-service.js';

export type AiDocumentOperation = 'summarize' | 'translate' | 'proofread' | 'rewrite';
export class DocumentAiService {
  constructor(private readonly model: ModelProvider, private readonly content: DocumentContentService, private readonly documents: DocumentService) {}
  async run(input: { fileId: string; outputName: string; operation: AiDocumentOperation; targetLanguage?: string; instructions?: string }): Promise<{ file: ManagedFile; text: string }> {
    const source = await this.content.extract(input.fileId);
    if (!source.text.trim()) throw badRequest('document has no extractable text; OCR is required for image-only documents');
    const system = this.systemPrompt(input.operation, input.targetLanguage, input.instructions);
    const text = await this.model.complete({ system, user: source.text });
    const file = await this.documents.create({ outputName: input.outputName, title: `${input.operation}: ${source.fileName}`, paragraphs: text.split(/\n+/).filter(Boolean) });
    return { file, text };
  }
  private systemPrompt(operation: AiDocumentOperation, targetLanguage?: string, instructions?: string): string {
    const intent: Record<AiDocumentOperation, string> = { summarize: 'Create a concise factual summary with key points.', translate: `Translate faithfully into ${targetLanguage || 'Korean'}. Preserve structure and do not add information.`, proofread: 'Correct grammar, spelling, and obvious clarity problems. Preserve meaning and tone.', rewrite: 'Rewrite for clarity and professional readability while preserving meaning.' };
    return `${intent[operation]} ${instructions ? `Additional instructions: ${instructions}` : ''}`;
  }
}
