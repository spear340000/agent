import { AppError } from '../shared/app-error.js';

export type LegalFailureKind =
  | 'startup'
  | 'transport'
  | 'timeout'
  | 'malformed'
  | 'protocol'
  | 'tool-error'
  | 'not-found'
  | 'indexing';

export const LEGAL_FAILURE_MESSAGES: Record<LegalFailureKind, string> = {
  startup:
    '법령 검색 프로세스를 시작하지 못했습니다. LEGAL_PYTHON과 LEGAL_RAG_ROOT 설정을 확인하세요.',
  transport:
    '법령 검색 프로세스 연결이 끊어졌습니다. 로컬 법령 저장소와 Python 환경 실행 상태를 확인하세요.',
  timeout:
    '법령 검색 시간이 초과되었습니다. 로컬 법령 인덱스가 준비되어 있는지 확인하세요.',
  malformed:
    '법령 검색 프로세스가 예상하지 못한 응답을 반환했습니다. 로컬 저장소를 다시 확인하세요.',
  protocol:
    '법령 검색 프로토콜 오류가 발생했습니다. 로컬 MCP 서버 설정을 확인하세요.',
  'tool-error': '법령 검색 도구가 오류를 반환했습니다.',
  'not-found': '로컬 법령 인덱스에서 해당 기록을 찾지 못했습니다.',
  indexing: '법령 지식 색인이 아직 준비되지 않았습니다.'
};

export const LEGAL_INDEXING_NOTICE = 'The legal knowledge base is loading in the background';

export class LegalRetrievalError extends AppError {
  constructor(
    public readonly kind: LegalFailureKind,
    message: string,
    details?: unknown
  ) {
    super(503, message, details);
    this.name = 'LegalRetrievalError';
  }
}

export function isLegalRetrievalError(error: unknown): error is LegalRetrievalError {
  return error instanceof LegalRetrievalError;
}

export function legalFailureMessage(error: unknown): string {
  if (isLegalRetrievalError(error)) {
    return error.kind === 'tool-error' || error.kind === 'not-found'
      ? error.message
      : `${LEGAL_FAILURE_MESSAGES[error.kind]} ${error.message}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
