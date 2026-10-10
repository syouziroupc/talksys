export const USAGE_TELEMETRY_REVISION = 'talksys-usage-v1-provider-metrics-r1';

function finiteCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function firstFinite(source, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return 0;
}

function interactionSearchCallCount(payload = {}) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  return steps.filter((step) => step?.type === 'google_search_call').length;
}

function generateContentSearchObserved(payload = {}) {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
  const grounding = candidate?.groundingMetadata || candidate?.grounding_metadata || {};
  const queries = grounding?.webSearchQueries || grounding?.web_search_queries || [];
  return Array.isArray(queries) && queries.length > 0;
}

export function normalizeGeminiUsage(payload = {}, options = {}) {
  const usage = payload?.usage || payload?.usageMetadata || payload?.usage_metadata || {};
  const inputTokens = firstFinite(usage, [
    'total_input_tokens',
    'input_tokens',
    'promptTokenCount',
    'prompt_token_count',
  ]);
  const outputTokens = firstFinite(usage, [
    'total_output_tokens',
    'output_tokens',
    'candidatesTokenCount',
    'candidates_token_count',
  ]);
  const cachedTokens = firstFinite(usage, [
    'total_cached_tokens',
    'cached_tokens',
    'cachedContentTokenCount',
    'cached_content_token_count',
  ]);
  const toolUseTokens = firstFinite(usage, [
    'total_tool_use_tokens',
    'tool_use_tokens',
    'toolUsePromptTokenCount',
    'tool_use_prompt_token_count',
  ]);
  const thoughtTokens = firstFinite(usage, [
    'thoughtsTokenCount',
    'thoughts_token_count',
  ]);
  const totalTokensReported = firstFinite(usage, [
    'total_tokens',
    'totalTokenCount',
    'total_token_count',
  ]);
  const groundingToolCount = firstFinite(usage, [
    'grounding_tool_count',
    'groundingToolCount',
  ]);
  const searchCalls = Math.max(
    groundingToolCount,
    interactionSearchCallCount(payload),
    generateContentSearchObserved(payload) ? 1 : 0,
  );
  const totalTokens = totalTokensReported || inputTokens + outputTokens + thoughtTokens;
  const usageAvailable = Object.keys(usage || {}).length > 0;

  return {
    revision: USAGE_TELEMETRY_REVISION,
    provider: 'gemini',
    transport: String(options?.transport || ''),
    providerCalls: finiteCount(options?.providerCalls ?? 1),
    searchCalls,
    inputTokens,
    outputTokens,
    cachedTokens,
    toolUseTokens,
    thoughtTokens,
    totalTokens,
    usageAvailable,
  };
}

export function mergeProviderUsage(records = []) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  const merged = {
    revision: USAGE_TELEMETRY_REVISION,
    provider: 'gemini',
    transport: '',
    providerCalls: 0,
    searchCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    toolUseTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    usageAvailable: false,
  };
  const transports = new Set();
  for (const record of list) {
    if (record?.transport) transports.add(String(record.transport));
    merged.providerCalls += finiteCount(record?.providerCalls);
    merged.searchCalls += finiteCount(record?.searchCalls);
    merged.inputTokens += finiteCount(record?.inputTokens);
    merged.outputTokens += finiteCount(record?.outputTokens);
    merged.cachedTokens += finiteCount(record?.cachedTokens);
    merged.toolUseTokens += finiteCount(record?.toolUseTokens);
    merged.thoughtTokens += finiteCount(record?.thoughtTokens);
    merged.totalTokens += finiteCount(record?.totalTokens);
    merged.usageAvailable = merged.usageAvailable || Boolean(record?.usageAvailable);
  }
  merged.transport = [...transports].join('+');
  return merged;
}
