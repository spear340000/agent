import { McpStdioClient } from './mcp-stdio-client.js';
import { LegalRetrievalService } from './legal-retrieval-service.js';
import { legalFailureMessage } from '../../domain/legal-error.js';
import { buildLegalMcpLaunchArgs } from './mcp-launch.js';

export type VectorContribution = {
  state: 'contributing' | 'ready' | 'disabled' | 'unavailable' | 'unknown';
  detail: string;
};

export type VectorContributionProbeOptions = {
  enabled: boolean;
  root: string;
  python: string;
  script: string;
  logPath?: string;
  env: (options: { useQdrant: boolean }) => Record<string, string>;
  query: string;
  timeoutMs: number;
  maxAgeMs?: number;
};

const LIMITS = { maxToolCalls: 2, maxRetrievalSteps: 2, maxQueryCharacters: 200, maxPrecedentCharacters: 2_000 };

export class VectorContributionProbe {
  private cached?: { value: VectorContribution; at: number };
  private running?: Promise<VectorContribution>;

  constructor(private readonly options: VectorContributionProbeOptions) {}

  async read(): Promise<VectorContribution> {
    const cached = this.cached;
    if (cached && Date.now() - cached.at < (this.options.maxAgeMs ?? 600_000)) return cached.value;
    if (this.running) return this.running;
    this.running = this.measure().finally(() => {
      this.running = undefined;
    });
    const value = await this.running;
    this.cached = { value, at: Date.now() };
    return value;
  }

  private async measure(): Promise<VectorContribution> {
    if (!this.options.enabled) {
      return { state: 'disabled', detail: '환경 설정으로 벡터 검색을 사용하지 않습니다.' };
    }
    const withVector = await this.topRecord(true);
    if ('error' in withVector) {
      return {
        state: 'unavailable',
        detail: `벡터 검색을 사용할 수 없어 키워드·그래프 검색만 사용합니다. ${withVector.error}`
      };
    }
    const withoutVector = await this.topRecord(false);
    if ('error' in withoutVector) {
      return { state: 'contributing', detail: '벡터 검색으로 조회했습니다(비교 기준 조회 실패).' };
    }
    if (withVector.recordId && withoutVector.recordId && withVector.recordId !== withoutVector.recordId) {
      return {
        state: 'contributing',
        detail: `임베딩 벡터가 검색 순서를 바꿉니다(“${this.options.query}” 기준: 벡터 ${withVector.label} / 키워드 ${withoutVector.label}).`
      };
    }
    return { state: 'ready', detail: '벡터 계층은 준비되어 있으나 기준 질의에서는 키워드 순서와 같습니다.' };
  }

  private async topRecord(
    useQdrant: boolean
  ): Promise<{ recordId: string; label: string } | { error: string }> {
    const client = new McpStdioClient({
      command: this.options.python,
      args: this.options.logPath
        ? buildLegalMcpLaunchArgs(this.options.script, this.options.logPath)
        : [this.options.script],
      cwd: this.options.root,
      env: this.options.env({ useQdrant }),
      startupTimeoutMs: this.options.timeoutMs,
      requestTimeoutMs: this.options.timeoutMs,
      maxResponseCharacters: 2_000_000,
      restartBudget: 0,
      stderrTailCharacters: 2_000
    });
    const retrieval = new LegalRetrievalService(client, LIMITS);
    try {
      const records = await retrieval.searchLaws(this.options.query, 3);
      const first = records[0];
      return { recordId: first?.recordId ?? '', label: first?.articleLabel ?? first?.lawName ?? '없음' };
    } catch (error) {
      return { error: legalFailureMessage(error) };
    } finally {
      await retrieval.close();
    }
  }
}
