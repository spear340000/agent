import type { LegalKnowledgeStatus } from '../domain/legal-source.js';

export type LegalRetrievalCapability = {
  enabled: boolean;
  ready: boolean;
  root: string;
  corpus: {
    laws: number | null;
    precedents: number | null;
    graphNodes: number | null;
    graphEdges: number | null;
  };
  vector: { ready: boolean; reason?: string };
  ontology: { ready: boolean };
  okf: { ready: boolean };
  degraded: string[];
  state: 'ready' | 'degraded' | 'unavailable' | 'disabled' | 'unknown';
  message: string;
};

export type RuntimeCapabilities = {
  model: { configured: boolean; provider: 'openai-compatible' | null };
  browserUse: { available: boolean };
  computerUse: { available: boolean; platform: NodeJS.Platform };
  legalRetrieval: LegalRetrievalCapability;
  office: {
    docx: boolean;
    xlsx: boolean;
    pdf: boolean;
    ocr: boolean;
    googleDocs: boolean;
    googleSheets: boolean;
    formulaCalculation: boolean;
  };
};

export const LEGAL_UNAVAILABLE_MESSAGE =
  '로컬 법령 검색을 사용할 수 없습니다. 법령 저장소 경로와 Python 실행 파일, 법령 색인 상태를 확인하세요.';

export function toLegalCapability(input: {
  enabled: boolean;
  root: string;
  status: LegalKnowledgeStatus | null;
  message?: string;
}): LegalRetrievalCapability {
  const base: LegalRetrievalCapability = {
    enabled: input.enabled,
    ready: false,
    root: input.root,
    corpus: { laws: null, precedents: null, graphNodes: null, graphEdges: null },
    vector: { ready: false },
    ontology: { ready: false },
    okf: { ready: false },
    degraded: [],
    state: 'unknown',
    message: LEGAL_UNAVAILABLE_MESSAGE
  };
  if (!input.enabled) {
    return { ...base, state: 'disabled', message: '법령 검색 기능이 설정에서 꺼져 있습니다.' };
  }
  const status = input.status;
  if (!status) {
    return { ...base, state: 'unknown', message: input.message ?? '법령 저장소 상태를 아직 확인하지 않았습니다.' };
  }
  const corpusReady = status.laws.ready || status.precedents.ready;
  const capability: LegalRetrievalCapability = {
    ...base,
    ready: corpusReady,
    corpus: {
      laws: status.laws.documents ?? null,
      precedents: status.precedents.documents ?? null,
      graphNodes: status.graph.nodes ?? null,
      graphEdges: status.graph.edges ?? null
    },
    vector: status.vector.ready ? { ready: true } : { ready: false, ...(status.vector.reason ? { reason: status.vector.reason } : {}) },
    ontology: { ready: status.ontology.ready },
    okf: { ready: status.okf.ready },
    degraded: status.degraded,
    state: !status.parsed ? 'unknown' : corpusReady ? (status.degraded.length ? 'degraded' : 'ready') : 'unavailable',
    message: corpusReady
      ? status.degraded.length
        ? '키워드·그래프 검색만 사용 가능합니다. 벡터 검색 계층은 사용하지 않습니다.'
        : '로컬 법령·판례 검색을 사용할 수 있습니다.'
      : input.message ?? LEGAL_UNAVAILABLE_MESSAGE
  };
  return capability;
}

export class CapabilityService {
  private legal: LegalRetrievalCapability;
  private legalCheckedAt = 0;

  constructor(
    private readonly state: {
      modelConfigured: boolean;
      browserAvailable: boolean;
      computerAvailable: boolean;
      platform: NodeJS.Platform;
      legal: LegalRetrievalCapability;
    },
    private readonly legalProbe?: { read(): Promise<LegalKnowledgeStatus | null>; maxAgeMs?: number }
  ) {
    this.legal = state.legal;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    await this.refreshLegal();
    return {
      model: { configured: this.state.modelConfigured, provider: this.state.modelConfigured ? 'openai-compatible' : null },
      browserUse: { available: this.state.browserAvailable },
      computerUse: { available: this.state.computerAvailable, platform: this.state.platform },
      legalRetrieval: this.legal,
      office: { docx: true, xlsx: true, pdf: true, ocr: false, googleDocs: false, googleSheets: false, formulaCalculation: false },
    };
  }

  setLegal(capability: LegalRetrievalCapability): void {
    this.legal = capability;
    this.legalCheckedAt = Date.now();
  }

  legalCapability(): LegalRetrievalCapability {
    return this.legal;
  }

  private async refreshLegal(): Promise<void> {
    if (!this.legalProbe || !this.legal.enabled) return;
    const maxAge = this.legalProbe.maxAgeMs ?? 60_000;
    if (this.legalCheckedAt > 0 && Date.now() - this.legalCheckedAt < maxAge) return;
    this.legalCheckedAt = Date.now();
    const status = await this.legalProbe.read();
    this.legal = toLegalCapability({ enabled: this.legal.enabled, root: this.legal.root, status, ...(status ? {} : { message: this.legal.message }) });
  }
}
