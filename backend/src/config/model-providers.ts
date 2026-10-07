export type ModelEndpointConfig = {
  name: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Requests longer than this skip the endpoint (for tiers with a small per-request token limit). */
  maxInputCharacters?: number;
  /** Requests wait, or move to the next provider, rather than exceed this rolling one-minute token budget. */
  tokensPerMinute?: number;
};

export type ModelProviderConfig = {
  primary: Omit<ModelEndpointConfig, 'apiKey'> & { apiKey?: string };
  fallbacks: ModelEndpointConfig[];
};

type Environment = Readonly<Record<string, string | undefined>>;

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
// Groq's free tier allows 8,000 tokens per request and minute; Korean text is about 1.6 characters per token.
const DEFAULT_GROQ_MAX_INPUT_CHARACTERS = 11_000;
const DEFAULT_GROQ_TOKENS_PER_MINUTE = 7_500;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_FALLBACK_MODEL = 'gpt-5-nano';
const DEFAULT_NVIDIA_FALLBACKS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
] as const;
const NVIDIA_FALLBACK_LIMIT = 5;

export function resolveModelProviderConfig(environment: Environment): ModelProviderConfig {
  const nvidiaKey = nonEmpty(environment.NVIDIA_API_KEY);
  const openAiKey = nonEmpty(environment.OPENAI_API_KEY);
  const primary: ModelProviderConfig['primary'] = {
    name: nvidiaKey ? 'NVIDIA' : 'OpenAI',
    apiKey: nvidiaKey ?? openAiKey,
    model: nonEmpty(environment.NVIDIA_MODEL) ?? nonEmpty(environment.OPENAI_MODEL) ?? DEFAULT_MODEL,
    baseUrl: normalizeBaseUrl(nvidiaKey
      ? nonEmpty(environment.NVIDIA_BASE_URL) ?? NVIDIA_BASE_URL
      : nonEmpty(environment.OPENAI_BASE_URL) ?? OPENAI_BASE_URL),
  };

  const fallbacks: ModelEndpointConfig[] = [];
  const configuredFallbacks = nonEmpty(environment.NVIDIA_FALLBACK_MODELS);
  if (configuredFallbacks && !nvidiaKey) throw new Error('NVIDIA_API_KEY is required when NVIDIA_FALLBACK_MODELS is set');
  const fallbackModels = configuredFallbacks
    ? configuredFallbacks.split(',').map(value => value.trim()).filter(Boolean)
    : nvidiaKey ? [...DEFAULT_NVIDIA_FALLBACKS] : [];
  const uniqueFallbacks = [...new Set(fallbackModels)];
  if (uniqueFallbacks.length > NVIDIA_FALLBACK_LIMIT) {
    throw new Error(`NVIDIA_FALLBACK_MODELS supports at most ${NVIDIA_FALLBACK_LIMIT} model IDs`);
  }
  for (const model of uniqueFallbacks) {
    if (!model.startsWith('nvidia/')) throw new Error('NVIDIA_FALLBACK_MODELS may contain only NVIDIA model IDs beginning with nvidia/');
    if (model === primary.model || !nvidiaKey) continue;
    fallbacks.push({
      name: 'NVIDIA NIM',
      apiKey: nvidiaKey,
      model,
      baseUrl: primary.baseUrl,
    });
  }

  if (nvidiaKey && openAiKey) {
    fallbacks.push({
      name: 'OpenAI',
      apiKey: openAiKey,
      model: nonEmpty(environment.OPENAI_FALLBACK_MODEL) ?? DEFAULT_OPENAI_FALLBACK_MODEL,
      baseUrl: normalizeBaseUrl(nonEmpty(environment.OPENAI_BASE_URL) ?? OPENAI_BASE_URL),
    });
  }

  return withGroq(environment, { primary, fallbacks });
}

/**
 * When GROQ_API_KEY is set, Groq becomes the primary model for speed and the previously configured primary and
 * fallbacks follow it unchanged, so a Groq outage or quota problem still falls through to the other providers.
 */
function withGroq(environment: Environment, base: ModelProviderConfig): ModelProviderConfig {
  const groqKey = nonEmpty(environment.GROQ_API_KEY);
  if (!groqKey) return base;
  const baseUrl = normalizeBaseUrl(nonEmpty(environment.GROQ_BASE_URL) ?? GROQ_BASE_URL);
  const primaryModel = nonEmpty(environment.GROQ_MODEL) ?? DEFAULT_GROQ_MODEL;
  const groqFallbackModels = [...new Set((nonEmpty(environment.GROQ_FALLBACK_MODELS) ?? '').split(',').map(value => value.trim()).filter(Boolean))]
    .filter(model => model !== primaryModel);
  const parsedLimit = Number(nonEmpty(environment.GROQ_MAX_INPUT_CHARACTERS));
  const maxInputCharacters = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_GROQ_MAX_INPUT_CHARACTERS;
  const parsedTpm = Number(nonEmpty(environment.GROQ_TOKENS_PER_MINUTE));
  const tokensPerMinute = Number.isSafeInteger(parsedTpm) && parsedTpm > 0 ? parsedTpm : DEFAULT_GROQ_TOKENS_PER_MINUTE;
  const previousPrimary = base.primary.apiKey ? [{ ...base.primary, apiKey: base.primary.apiKey }] : [];
  return {
    primary: { name: 'Groq', apiKey: groqKey, model: primaryModel, baseUrl, maxInputCharacters, tokensPerMinute },
    fallbacks: [
      ...groqFallbackModels.map(model => ({ name: 'Groq', apiKey: groqKey, model, baseUrl, maxInputCharacters, tokensPerMinute })),
      ...previousPrimary,
      ...base.fallbacks
    ]
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('model provider base URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('model provider base URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

