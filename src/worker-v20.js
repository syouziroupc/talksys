import { runWithTools } from '@cloudflare/ai-utils';
import baseWorker, { TalkSysVoiceAgent as BaseTalkSysVoiceAgent } from './worker-v14.js';
import appV19 from './index-v19.js';
import { SEARCH_TRACE_CLIENT } from './search-trace-client.js';
import { QUALITY_CONVERSATION_MODEL } from './cloudflare-llm.js';
import { streamBoundedQualityConversation } from './bounded-conversation.js';
import { collectWebEvidenceV20, compactToolEvidence, SEARCH_TOOL_V20_REVISION } from './search-tool-v20.js';

const VOICE_REVISION = 'cloudflare-agent-tools-v20.0';

const AGENT_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
会話の中枢はあなた一人です。直前までの会話履歴を使い、ユーザーの条件や訂正を自然に引き継いでください。
普通の会話、相談、一般知識、安定した製品選びの助言は、そのまま自分で答えてください。
現在の価格、在庫、営業時間、ニュース、天気、現行制度・法律、運行情報、現在の店舗や購入先など、外部確認が必要な事実だけ web_search を使ってください。
ユーザーが「検索して」「調べて」と明示した場合も web_search を使ってください。
web_search の query は検索単独で意味が通るようにし、会話で分かっている地域、対象、予算など必要な条件を含めてください。
検索結果を受け取った後も同じ会話として答えてください。検索結果のタイトルをそのまま回答にしたり、SEO記事を店舗・商品として扱ったりしないでください。
現在事実や固有名詞は検索根拠にある範囲だけ述べ、根拠が不足した部分を推測で埋めないでください。
電話で自然に聞ける日本語にし、結論を先に、通常は2〜5文程度で答えてください。URL、Markdown、検索処理の内部説明は読み上げないでください。`;

const FRESH_FACT_RE = /(最新|現在|いま|今の|今日|明日|昨日|ニュース|価格|値段|在庫|営業時間|営業中|天気|株価|為替|相場|発売|販売中|現行法|法改正|制度改正|予定|日程|時刻表|運行|空席|予約状況)/i;
const EXPLICIT_SEARCH_RE = /(検索して|検索|調べて|調べる|ウェブで|Webで|ネットで調べ|最新情報)/i;
const LOCAL_PURCHASE_RE = /(どこで買|どこに売|買える(?:店|場所)|近くの?(?:店|店舗)|(?:店|店舗|販売店).{0,18}(?:ある|開い|営業|在庫)|(?:市内|県内).{0,18}(?:店|店舗|買))/i;

export function requiresFreshSearch(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return FRESH_FACT_RE.test(value) || EXPLICIT_SEARCH_RE.test(value) || LOCAL_PURCHASE_RE.test(value);
}

function connectionFrom(context) {
  return context?.connection || context || null;
}

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v20-${source}` : '';
}

function send(connection, payload) {
  try { connection?.send(JSON.stringify(payload)); } catch {}
}

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION,
    },
  });
}

function readText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.result === 'string') return payload.result;
  const choice = payload.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.delta?.content === 'string') return choice.delta.content;
  if (Array.isArray(choice?.delta?.content)) {
    return choice.delta.content.map((item) => typeof item === 'string' ? item : (item?.text || '')).join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  return '';
}

async function* streamToolResult(result) {
  if (!result) return;
  if (typeof result === 'string') {
    if (result.trim()) yield result;
    return;
  }
  if (result instanceof ReadableStream || typeof result?.getReader === 'function') {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line === 'data: [DONE]') continue;
          const body = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (!body || body === '[DONE]') continue;
          try {
            const text = readText(JSON.parse(body));
            if (text) yield text;
          } catch {}
        }
      }
      pending += decoder.decode();
      if (pending.trim()) {
        const body = pending.trim().startsWith('data:') ? pending.trim().slice(5).trim() : pending.trim();
        try {
          const text = readText(JSON.parse(body));
          if (text) yield text;
        } catch {}
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }
  if (typeof result[Symbol.asyncIterator] === 'function') {
    for await (const event of result) {
      const text = readText(event);
      if (text) yield text;
    }
    return;
  }
  const text = readText(result);
  if (text) yield text;
}

function baseMessages(history, transcript) {
  return [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-24) : []),
    { role: 'user', content: transcript },
  ];
}

function evidenceMessages(history, transcript, result) {
  const sources = Array.isArray(result.sources) ? result.sources.slice(0, 10) : [];
  const compact = sources.map((item, index) => {
    const evidence = String(item.excerpt || item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 1300);
    return `[${index + 1}] ${String(item.title || '').slice(0, 180)}\n${String(item.url || '').slice(0, 800)}\n${evidence}`;
  }).join('\n\n');
  return [
    { role: 'system', content: `${AGENT_SYSTEM_PROMPT}\n今回はWeb検索済みです。下の検索根拠を使い、別の検索回答システムへ切り替えず、あなた自身が会話の続きとして回答してください。` },
    ...(Array.isArray(history) ? history.slice(-24) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[Web検索ツールの根拠]\n${compact || '(有効な根拠を取得できませんでした)'}`,
    },
  ];
}

export class TalkSysVoiceAgent extends BaseTalkSysVoiceAgent {
  async collectSearchEvidence(query, transcript, history, context) {
    const connection = connectionFrom(context);
    send(connection, {
      type: 'search_status',
      phase: 'searching',
      searched: true,
      waitPhrase: '少し調べますね。',
    });
    send(connection, {
      type: 'search_trace',
      phase: 'searching',
      message: '会話AIがWeb検索ツールを使用しています',
    });

    const result = await collectWebEvidenceV20(query || transcript, history, {
      signal: context?.signal,
      onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
    });

    send(connection, {
      type: 'search_status',
      phase: 'done',
      searched: true,
      provider: SEARCH_TOOL_V20_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceUseful: Boolean(result.sources?.length),
      sources: (result.sources || []).slice(0, 10).map((item) => ({ title: item.title, url: item.url })),
      timings: { searchMs: result.elapsedMs },
    });
    return result;
  }

  mandatorySearchTurn(transcript, context, history) {
    const self = this;
    return (async function* () {
      const result = await self.collectSearchEvidence(transcript, transcript, history, context);
      const messages = evidenceMessages(history, transcript, result);
      yield* streamBoundedQualityConversation(self.env.AI, messages, {
        signal: context?.signal,
        maxTokens: 420,
        openTimeoutMs: 2800,
        firstTokenTimeoutMs: 3200,
        fallbackTimeoutMs: 3400,
        sessionAffinity: sessionAffinity(context),
      });
    })();
  }

  embeddedAgentTurn(transcript, context, history) {
    const self = this;
    return (async function* () {
      const tool = {
        name: 'web_search',
        description: 'Search the public web for current or externally verifiable information. Use for current prices, stock, opening hours, news, weather, current laws or systems, schedules, real-world stores and purchase locations, or whenever the user explicitly asks you to search. Do not use for greetings, ordinary conversation, personal advice, or stable general knowledge.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A standalone search query. Include relevant subject, location, budget, date, or other constraints already known from the conversation.',
            },
          },
          required: ['query'],
        },
        function: async ({ query }) => {
          const result = await self.collectSearchEvidence(String(query || transcript), transcript, history, context);
          return JSON.stringify(compactToolEvidence(result));
        },
      };

      try {
        const result = await runWithTools(
          self.env.AI,
          QUALITY_CONVERSATION_MODEL,
          {
            messages: baseMessages(history, transcript),
            tools: [tool],
          },
          {
            streamFinalResponse: true,
            maxRecursiveToolRuns: 1,
            strictValidation: false,
            verbose: false,
          },
        );
        let produced = false;
        for await (const delta of streamToolResult(result)) {
          produced = true;
          yield delta;
        }
        if (produced) return;
      } catch {}

      // Function-calling is a capability enhancement, not a single point of failure.
      // If the embedded tool runtime fails, preserve the conversation with the same
      // quality model family rather than falling into the old search-answer cascade.
      yield* streamBoundedQualityConversation(self.env.AI, baseMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: 360,
        openTimeoutMs: 2600,
        firstTokenTimeoutMs: 3000,
        fallbackTimeoutMs: 3200,
        sessionAffinity: sessionAffinity(context),
      });
    })();
  }

  async onTurn(transcript, context) {
    const connection = connectionFrom(context);
    const history = this.getTalkSysHistory(connection);
    const iterable = requiresFreshSearch(transcript)
      ? this.mandatorySearchTurn(transcript, context, history)
      : this.embeddedAgentTurn(transcript, context, history);
    return this.trackAssistant(iterable, context, 'single-agent-v20', transcript);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') return appV19.fetch(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT);
    if (request.method === 'GET' && url.pathname === '/health') return appV19.fetch(request, env, ctx);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await baseWorker.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'single-agent-v20',
        primaryConversationModel: QUALITY_CONVERSATION_MODEL,
        toolCalling: 'cloudflare-embedded-function-calling',
        webSearchTool: SEARCH_TOOL_V20_REVISION,
        webSearchToolRole: 'evidence-only',
        modelDecidesToolUse: true,
        mandatoryFreshSearchGuard: true,
        searchPlannerBeforeRetrieval: false,
        searchAnswerCascade: false,
        searchAuditModelCascade: false,
        fixedSearchWaitSpeech: true,
        searchWaitPhrase: '少し調べますね。',
        legacyV19Available: true,
        voiceBuiltinHistoryDisabled: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return baseWorker.fetch(request, env, ctx);
  },
};
