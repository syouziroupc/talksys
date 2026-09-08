import baseWorker, { TalkSysVoiceAgent as BaseTalkSysVoiceAgent } from './worker-v14.js';
import appV19 from './index-v19.js';
import { SEARCH_TRACE_CLIENT } from './search-trace-client.js';
import { CLOUDFLARE_LIVE_CLIENT_V20 } from './cloudflare-live-client-v20.js';
import { LIVE_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL } from './cloudflare-llm.js';
import { streamBoundedLiveConversation, streamBoundedQualityConversation } from './bounded-conversation.js';
import { collectWebEvidenceV20, SEARCH_TOOL_V20_REVISION } from './search-tool-v20.js';
import { requiresFreshSearch } from './search-policy-v20.js';

const VOICE_REVISION = 'cloudflare-agent-v20.2-audio-search';

const NORMAL_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
同じ通話の直前までの会話履歴を使い、ユーザーの条件や訂正を自然に引き継いでください。
普通の会話、相談、一般知識、安定した製品選びの助言は直接答えてください。
専門用語を相手が理解していない様子なら、スペック名の羅列をやめて「何を選べばよいか」を平易な日本語で言い換えてください。
この通常会話経路ではWeb検索は実行しません。現在の価格、在庫、営業時間、電話番号、住所、ニュース、天気、現行制度、実在店舗など検索が必要な質問は別の検索経路へ自動的に振り分けられます。
検索していないのに「検索します」「Web検索を実行」「検索経路で確認」などと言わないでください。
電話で自然に聞ける日本語にし、結論を先に、通常は2〜4文程度で答えてください。URL、Markdown、内部処理説明は読み上げないでください。`;

const QUALITY_SYSTEM_PROMPT = `${NORMAL_SYSTEM_PROMPT}
今回は少し考える必要がある相談です。論点を整理して答えてください。ただし電話で一度に理解できる長さにしてください。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。取得した検索根拠と同じ通話の会話履歴だけを使い、会話の続きとして答えてください。
現在の店舗名、会社名、施設名、価格、在庫、営業時間、電話番号、住所、法律、現行仕様などは検索根拠にある範囲だけ述べてください。
ユーザーが特定店舗の電話番号・住所・営業時間などを聞いた場合、根拠にその情報があれば最初の一文で直接答えてください。「検索します」「確認します」と言って終わらないでください。
購入先を聞かれた場合は、検索根拠の中から実在性と関連性が高い候補だけを2〜4件程度挙げてください。観光サイト、百科事典、SEOまとめ記事を店として扱わないでください。
検索結果のタイトルをそのまま店舗名や商品名として扱わず、SEO記事やまとめ記事と実在する候補を区別してください。
根拠が不足した部分は推測で埋めないでください。確認できた候補がない場合は、確認できなかったと短く明示してください。
電話で自然に聞ける日本語にし、結論を先に、通常は2〜5文程度で答えてください。URL、Markdown、検索処理の内部説明は読み上げないでください。`;

const QUALITY_INTENT_RE = /(どう考える|なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|将来|実現可能)/i;

function needsQualityConversation(text) {
  const value = String(text || '').trim();
  return value.length >= 120 || QUALITY_INTENT_RE.test(value);
}

function quickCasualReply(text) {
  const value = String(text || '').trim().replace(/[！!。．.]+$/u, '');
  if (/^(こんにちは|こんにちわ|やあ|どうも)$/u.test(value)) return 'こんにちは。どうしました？';
  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。どうしました？';
  if (/^こんばんは$/u.test(value)) return 'こんばんは。どうしました？';
  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。';
  if (/^(元気|元気ですか|お元気ですか)$/u.test(value)) return '元気ですよ。ありがとうございます。';
  return '';
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

function normalMessages(history, transcript, quality = false) {
  return [
    { role: 'system', content: quality ? QUALITY_SYSTEM_PROMPT : NORMAL_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-16) : []),
    { role: 'user', content: transcript },
  ];
}

function evidenceMessages(history, transcript, result) {
  const sources = Array.isArray(result.sources) ? result.sources.slice(0, 8) : [];
  const compact = sources.map((item, index) => {
    const evidence = String(item.excerpt || item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    return `[${index + 1}] ${String(item.title || '').slice(0, 180)}\n${String(item.url || '').slice(0, 700)}\n${evidence}`;
  }).join('\n\n');
  return [
    { role: 'system', content: GROUNDED_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-14) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[Web検索の根拠]\n${compact || '(有効な根拠を取得できませんでした)'}`,
    },
  ];
}

function emptySearchResult(query, started, error = '') {
  return {
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: String(query || '').trim(),
    queries: [String(query || '').trim()].filter(Boolean),
    sources: [],
    evidence: '',
    elapsedMs: Date.now() - started,
    error: String(error || '').slice(0, 180),
  };
}

export class TalkSysVoiceAgent extends BaseTalkSysVoiceAgent {
  async collectSearchEvidence(query, transcript, history, context) {
    const connection = connectionFrom(context);
    const started = Date.now();
    send(connection, {
      type: 'search_status',
      phase: 'searching',
      searched: true,
      waitPhrase: '少し調べますね。',
    });
    send(connection, {
      type: 'search_trace',
      phase: 'searching',
      message: 'Web検索を開始',
      resolvedQuestion: String(query || transcript || '').trim(),
    });

    let result;
    try {
      result = await collectWebEvidenceV20(query || transcript, history, {
        signal: context?.signal,
        onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
      });
    } catch (error) {
      result = emptySearchResult(query || transcript, started, error?.message || error);
      send(connection, {
        type: 'search_trace',
        phase: 'evidence_ready',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: 0,
        sources: [],
        message: '検索結果を取得できませんでした',
      });
    }

    send(connection, {
      type: 'search_status',
      phase: 'done',
      searched: true,
      provider: SEARCH_TOOL_V20_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceUseful: Boolean(result.sources?.length),
      sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
      timings: { searchMs: result.elapsedMs },
    });
    return result;
  }

  mandatorySearchTurn(transcript, context, history) {
    const self = this;
    return (async function* () {
      const connection = connectionFrom(context);
      const result = await self.collectSearchEvidence(transcript, transcript, history, context);
      send(connection, {
        type: 'search_trace',
        phase: 'answering',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })),
        message: '検索根拠から回答を生成',
      });

      if (!result.sources?.length) {
        yield '確認できる検索結果を取得できませんでした。店名や番号は推測せずに答えます。';
        send(connection, {
          type: 'search_trace',
          phase: 'done',
          resolvedQuestion: result.resolvedQuestion,
          queries: result.queries,
          evidenceCount: 0,
          sources: [],
          message: '検索結果なし',
        });
        return;
      }

      const messages = evidenceMessages(history, transcript, result);
      yield* streamBoundedQualityConversation(self.env.AI, messages, {
        signal: context?.signal,
        maxTokens: 340,
        openTimeoutMs: 2300,
        firstTokenTimeoutMs: 2500,
        fallbackTimeoutMs: 3200,
        sessionAffinity: sessionAffinity(context),
      });

      send(connection, {
        type: 'search_trace',
        phase: 'done',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })),
        message: '検索回答を完了',
      });
    })();
  }

  normalConversationTurn(transcript, context, history) {
    const quick = quickCasualReply(transcript);
    if (quick) {
      return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v20.2', transcript);
    }

    const quality = needsQualityConversation(transcript);
    const messages = normalMessages(history, transcript, quality);
    if (quality) {
      return this.trackAssistant(
        streamBoundedQualityConversation(this.env.AI, messages, {
          signal: context?.signal,
          maxTokens: 300,
          openTimeoutMs: 2100,
          firstTokenTimeoutMs: 2400,
          fallbackTimeoutMs: 3000,
          sessionAffinity: sessionAffinity(context),
        }),
        context,
        'quality-fast-v20.2',
        transcript,
      );
    }

    return this.trackAssistant(
      streamBoundedLiveConversation(this.env.AI, messages, {
        signal: context?.signal,
        maxTokens: 260,
        openTimeoutMs: 1700,
        firstTokenTimeoutMs: 2000,
        fallbackTimeoutMs: 2500,
        sessionAffinity: sessionAffinity(context),
      }),
      context,
      'live-fast-v20.2',
      transcript,
    );
  }

  async onTurn(transcript, context) {
    const connection = connectionFrom(context);
    const history = this.getTalkSysHistory(connection);
    if (requiresFreshSearch(transcript)) {
      return this.trackAssistant(this.mandatorySearchTurn(transcript, context, history), context, 'deterministic-search-v20.2', transcript);
    }
    return this.normalConversationTurn(transcript, context, history);
  }
}

async function runSearchSmoke(transcript, history = []) {
  const started = Date.now();
  try {
    const result = await collectWebEvidenceV20(transcript, history);
    return Response.json({
      ok: Boolean(result.sources?.length),
      routedToSearch: requiresFreshSearch(transcript),
      revision: SEARCH_TOOL_V20_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceCount: result.sources?.length || 0,
      elapsedMs: result.elapsedMs,
      sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url, engine: item.engine })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      routedToSearch: requiresFreshSearch(transcript),
      revision: SEARCH_TOOL_V20_REVISION,
      error: String(error?.message || error).slice(0, 240),
      elapsedMs: Date.now() - started,
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

function searchSmoke() {
  return runSearchSmoke(
    '大分県別府市に住んでるんだけどなんかどこかで買えないかな いい場所を知ってたら教えてください',
    [
      { role: 'user', content: 'パソコンの買い替えについて相談に乗って欲しい' },
      { role: 'assistant', content: '用途を教えてください。' },
      { role: 'user', content: 'YouTubeとインターネットだけ見れれば何でもいい。安い方がいい。' },
    ],
  );
}

function yokohamaSearchSmoke() {
  return runSearchSmoke(
    '今 横浜市の高島町にいるんだけど 近くに買えそうなお店ってないかな',
    [
      { role: 'user', content: 'パソコンを買い換えたい' },
      { role: 'user', content: 'ネットサーフィンができれば何でもいい。5万円ぐらいで中古でもいい' },
    ],
  );
}

function contactSearchSmoke() {
  return runSearchSmoke('ドスパラ横浜駅前店の電話番号教えてよ', [
    { role: 'user', content: '横浜駅周辺のパソコン販売店は例えばどこがある' },
    { role: 'assistant', content: 'ドスパラ横浜駅前店があります。' },
  ]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') return appV19.fetch(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V20);
    if (request.method === 'GET' && url.pathname === '/health') return appV19.fetch(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/api/search-smoke') return searchSmoke();
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-yokohama') return yokohamaSearchSmoke();
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-contact') return contactSearchSmoke();

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await baseWorker.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'tiered-fast-agent-v20.2',
        primaryConversationModel: LIVE_CONVERSATION_MODEL,
        qualityConversationModel: QUALITY_CONVERSATION_MODEL,
        toolCalling: 'deterministic-search-router-v20.2',
        webSearchTool: SEARCH_TOOL_V20_REVISION,
        webSearchToolRole: 'evidence-only',
        modelDecidesToolUse: false,
        mandatoryFreshSearchGuard: true,
        ordinaryConversationUsesToolInference: false,
        instantLocalGreeting: true,
        normalConversationFastPath: true,
        midStreamContinuationRecovery: true,
        browserMicEchoCancellation: true,
        browserMicNoiseSuppression: true,
        browserMicAutoGainControl: true,
        audioWorkletCapture: true,
        scriptProcessorMicFallback: true,
        microphoneMonitorMuted: true,
        strictHalfDuplexEchoGuard: true,
        playbackTailGuardMs: 700,
        searchPlannerBeforeRetrieval: false,
        searchAnswerCascade: false,
        searchAuditModelCascade: false,
        localSearchEvidenceFilter: true,
        localSearchOpenStreetMapFallback: true,
        namedBusinessContactSearch: true,
        fixedSearchWaitSpeech: true,
        searchWaitPhrase: '少し調べますね。',
        searchSmokeEndpoint: '/api/search-smoke',
        yokohamaSearchSmokeEndpoint: '/api/search-smoke-yokohama',
        contactSearchSmokeEndpoint: '/api/search-smoke-contact',
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
