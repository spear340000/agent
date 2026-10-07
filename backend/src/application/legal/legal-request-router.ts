import type { LegalRetrievalStep } from '../../domain/legal-source.js';
import { extractLawArticle, ARTICLE_NUMBER_PATTERN as BARE_ARTICLE_PATTERN } from '../../domain/legal-reference.js';
export { extractLawArticle } from '../../domain/legal-reference.js';

export type LegalIntent =
  | 'article-lookup'
  | 'case-lookup'
  | 'legal-question'
  | 'legal-draft'
  | 'legal-research'
  | 'non-legal';

export type LegalPath = 'direct' | 'orchestrated' | 'document';

export type LegalRouteDecision = {
  path: LegalPath;
  intent: LegalIntent;
  legal: boolean;
  plannerCalls: number;
  reasons: string[];
  originalPrompt: string;
  article?: { lawName?: string; articleNumber: string };
  caseNumber?: string;
  draftKind?: string;
  questions: string[];
  queries: string[];
  webQueries: string[];
  needsWeb: boolean;
  attachmentCount: number;
  steps: LegalRetrievalStep[];
};

export type LegalRoutingLimits = {
  multiIssueThreshold: number;
  complexDraftCharacters: number;
  multiAttachmentThreshold: number;
  directQueryLimit: number;
  maxDirectQueryCharacters?: number;
};

const CASE_NUMBER_PATTERN = /(?:^|[^\d])(\d{4}[가-힣]{1,2}\d{2,})(?!\d)/;
const EFFECTIVE_DATE_PATTERN = /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*(?:시행|부터)/;
const LAW_REFERENCE_PATTERN = /(?:법률|법|령|규칙|조칙)[^\n]{0,16}제\d+조/;
const ISSUE_SEPARATOR = /[?？]|그리고|또한|한편|뿐만\s*아니라|게다가/g;
const PROMPT_NOISE = /[\r\n]+/g;

const OUTPUT_SHAPE = /초안|서식|양식|작성|써\s|만들|정식|서류/;
const WEB_NEEDED = /최신|현재|요즘|오늘|공지|고시|발표|공식\s*(?:사이트|출처|링크)|원문\s*링크|링크|https?:\/\//i;

const DEFAULT_STEP_LABELS: Readonly<Record<LegalPath, readonly string[]>> = {
  document: [],
  direct: ['법령·판례 근거 확인', '근거 기반 답변 작성'],
  orchestrated: ['검색 계획 수립', '제한된 근거 수집', '근거 검증', '근거 기반 답변 작성']
};

const normalize = (value: string): string => value.replace(PROMPT_NOISE, ' ').replace(/\s+/g, ' ').trim();

export function countIssueSignals(prompt: string): number {
  const numberedItems = (prompt.match(/^\s*(?:\d{1,3}[.)]|[-*•])\s+\S/gm) ?? []).length;
  return Math.max((normalize(prompt).match(ISSUE_SEPARATOR) ?? []).length, numberedItems);
}

export function extractCaseNumber(prompt: string): string | undefined {
  return CASE_NUMBER_PATTERN.exec(normalize(prompt))?.[1];
}

export type LegalCitationFormats = {
  article: boolean;
  caseNumber: boolean;
  lawReference: boolean;
  effectiveDate: boolean;
};

export function legalCitationFormats(prompt: string): LegalCitationFormats {
  const text = normalize(prompt);
  return {
    article: BARE_ARTICLE_PATTERN.test(text),
    caseNumber: CASE_NUMBER_PATTERN.test(text),
    lawReference: LAW_REFERENCE_PATTERN.test(text),
    effectiveDate: EFFECTIVE_DATE_PATTERN.test(text)
  };
}

export function hasLegalCitationFormat(prompt: string): boolean {
  const formats = legalCitationFormats(prompt);
  return formats.article || formats.caseNumber || formats.lawReference || formats.effectiveDate;
}

export class LegalRequestRouter {
  constructor(private readonly limits: LegalRoutingLimits) {}

  route(input: { prompt: string; attachmentCount?: number; sourceUrlCount?: number }): LegalRouteDecision {
    const prompt = normalize(input.prompt);
    const attachmentCount = input.attachmentCount ?? 0;
    const sourceUrlCount = input.sourceUrlCount ?? 0;
    const reasons: string[] = [];
    const article = extractLawArticle(prompt);
    const caseNumber = extractCaseNumber(prompt);
    const formats = legalCitationFormats(prompt);
    const mentionsDraft = OUTPUT_SHAPE.test(prompt);
    const issueCount = countIssueSignals(input.prompt);
    const manyAttachments = attachmentCount >= this.limits.multiAttachmentThreshold;
    const complexDraft = mentionsDraft && prompt.length > this.limits.complexDraftCharacters;
    const multiIssue = issueCount >= this.limits.multiIssueThreshold;
    const citationFormat = formats.article || formats.caseNumber || formats.lawReference || formats.effectiveDate;

    reasons.push(
      citationFormat
        ? '법령 인용 형식(조문·사건번호·시행일)을 확인했습니다.'
        : '요청 내용을 그대로 법률 조회 대상으로 삼습니다.'
    );

    const questions = splitQuestions(prompt);
    const needsWeb = sourceUrlCount > 0 || WEB_NEEDED.test(prompt);
    const longSearch = !article?.lawName && !caseNumber && input.prompt.length > (this.limits.maxDirectQueryCharacters ?? 300);
    const orchestrated = manyAttachments || multiIssue || complexDraft || longSearch;

    const intent: LegalIntent = caseNumber
      ? 'case-lookup'
      : article && !mentionsDraft
        ? 'article-lookup'
        : orchestrated
          ? 'legal-research'
          : mentionsDraft
            ? 'legal-draft'
            : 'legal-question';

    if (manyAttachments) reasons.push(`첨부 자료가 ${attachmentCount}개 이상입니다.`);
    if (multiIssue) reasons.push(`요청이 ${issueCount}개 항목으로 나뉘어 있어 여러 번의 검색이 필요합니다.`);
    if (complexDraft) reasons.push('긴 법률 문서 초안 요청이 확인되었습니다.');
    if (longSearch) reasons.push('원문이 직접 검색 질의 한도를 넘어 검색 계획이 필요합니다.');

    const path: LegalPath = orchestrated ? 'orchestrated' : 'direct';
    const queries = buildQueries(prompt, intent);
    const steps = orchestrated ? [] : this.directSteps(input.prompt, intent, article, caseNumber);
    return this.decision(path, intent, reasons, prompt, input.prompt, attachmentCount, {
      article,
      caseNumber,
      draftKind: mentionsDraft ? 'legal-document' : undefined,
      questions,
      queries,
      webQueries: needsWeb ? buildWebQueries(input.prompt) : [],
      needsWeb,
      steps
    });  }

  stepLabels(path: LegalPath, options: { needsWeb?: boolean; draft?: boolean } = {}): string[] {
    const labels = [...(DEFAULT_STEP_LABELS[path] ?? [])];
    if (path === 'document') return labels;
    if (options.needsWeb) labels.splice(Math.max(labels.length - 1, 0), 0, '공개 웹 자료 확인');
    if (options.draft) labels.push('법률 문서 초안 작성');
    return labels;
  }

  private directSteps(
    prompt: string,
    intent: LegalIntent,
    article: { lawName?: string; articleNumber: string } | undefined,
    caseNumber: string | undefined
  ): LegalRetrievalStep[] {
    const query = prompt;
    const steps: LegalRetrievalStep[] = [];
    if (intent === 'case-lookup' && caseNumber) {
      steps.push({ kind: 'case-number', caseNumber });
      return steps;
    }
    if (article?.lawName) steps.push({ kind: 'law-article', lawName: article.lawName, articleNumber: article.articleNumber });
    else steps.push({ kind: 'search-laws', query, limit: 5 });
    if (intent !== 'article-lookup' || !article?.lawName) steps.push({ kind: 'search-precedents', query, limit: 5 });
    return steps.slice(0, this.limits.directQueryLimit + 1);
  }

  private decision(
    path: LegalPath,
    intent: LegalIntent,
    reasons: string[],
    prompt: string,
    originalPrompt: string,
    attachmentCount: number,
    extra: {
      notes?: string[];
      article?: { lawName?: string; articleNumber: string };
      caseNumber?: string;
      draftKind?: string;
      questions?: string[];
      queries?: string[];
      webQueries?: string[];
      needsWeb?: boolean;
      steps?: LegalRetrievalStep[];
    }
  ): LegalRouteDecision {
    return {
      path,
      intent,
      legal: intent !== 'non-legal',
      plannerCalls: path === 'orchestrated' ? 1 : 0,
      reasons,
      originalPrompt,
      article: extra.article,
      caseNumber: extra.caseNumber,
      draftKind: extra.draftKind,
      questions: extra.questions ?? [prompt],
      queries: extra.queries ?? [],
      webQueries: extra.webQueries ?? [],
      needsWeb: extra.needsWeb ?? false,
      attachmentCount,
      steps: extra.steps ?? []
    };
  }
}

export function splitQuestions(prompt: string): string[] {
  return prompt
    .split(ISSUE_SEPARATOR)
    .map(part => part.trim())
    .filter(part => part.length > 1);
}

function buildQueries(prompt: string, intent: LegalIntent): string[] {
  const queries = splitQuestions(prompt);
  if (intent === 'article-lookup') queries.push(prompt);
  if (intent === 'case-lookup') queries.unshift(prompt);
  return [...new Set(queries.map(query => query.slice(0, 300)))].filter(Boolean);
}

function buildWebQueries(prompt: string): string[] {
  return [prompt];
}
