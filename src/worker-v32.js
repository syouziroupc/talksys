import workerV31, { TalkSysVoiceAgent as TalkSysVoiceAgentV31 } from './worker-v31.js';
import { CLOUDFLARE_LIVE_CLIENT_V32 } from './cloudflare-live-client-v32.js';
import { SEARCH_TRACE_CLIENT_V32 } from './search-trace-client-v32.js';
import { recordConversationUser } from './conversation-memory.js';
import { cleanSpeechText } from './voice-helpers.js';
import { groundingDecisionV22 } from './grounding-policy-v22.js';
import { streamGlmConversationV32, GLM_CONVERSATION_MODEL_V32 } from './glm-conversation-v32.js';

const VOICE_REVISION = 'cloudflare-agent-v32-coherent-reliable-glm-melo';
const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const QUALITY_INTENT_RE = /(どう考える|なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|将来|実現可能|検討|判断|基準|選び方)/i;
const HARD_SEARCH_RE = /(検索して|調べて|ウェブで|Webで|ネットで確認|最新|現在|今日|明日|昨日|今年|今月|ニュース|価格|値段|相場|在庫|営業時間|営業中|天気|株価|為替|発売|販売中|現行|法改正|制度改正|予定|日程|時刻表|運行|遅延|空席|予約状況|電話番号|連絡先|住所|所在地|アクセス|公式サイト|URL|ランキング|順位|どこで買|どこに売|近くの|店舗|販売店|家電量販店|乗り換え|乗換|経路|行き方|所要時間|運賃)/i;
const GENERAL_ADVICE_RE = /(相談|どう思う|どう考える|どう決め|どう選|選び方|選ぶ基準|基準で|でもいいかな|でも大丈夫|した方がいい|すべき|向いている|必要かな)/i;

const GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
同じ通話の会話履歴を必ず使い、直前までに分かっている対象・用途・予算・希望を自然に引き継いでください。分かっていることを聞き直さないでください。
人と電話で会話している自然な日本語で返してください。電文調、単語だけの返答、ぶつ切りの短文、同じ表現の反復は禁止です。
長さを機械的に1〜3文へ制限しません。簡単な質問は短く、相談や判断が必要なら通常2〜5文程度を目安に、必要な理由まで自然につないでください。
最初に役立つ答えを出し、そのあと必要な理由や次の確認を続けてください。質問が必要なら一度に1つだけにしてください。
この経路ではWeb検索していません。価格、在庫、営業時間、ニュース、法律、現行仕様など変化する外部事実や、確認していない具体的数値を記憶だけで断定しないでください。
URL、Markdown、内部処理、モデル名は読み上げないでください。`;

const PC_PROMPT = `${GENERAL_PROMPT}
パソコン相談では販売・修理の実務者として、用途と不満から必要な性能を判断してください。
CPU世代、メモリ、SSD、画面、端子などは判断に必要なものだけ使い、仕様一覧を読み上げないでください。
買い替え相談では、いきなり製品を決めつけず、既に分かっている用途・予算を使って次の判断へ進めてください。`;

const GROUNDED_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
このターンではWeb確認済みです。具体的な外部事実は今回提示された根拠に直接支えられる内容だけを使ってください。
人と電話で話す自然な日本語で、検索結果の読み上げではなく質問への答えとしてまとめてください。電文調、ぶつ切り、同じ語句の反復は禁止です。
長さを1〜3文へ固定しません。通常2〜5文程度を目安に、答え・重要な理由・必要なら次の確認を自然につないでください。
検索の成否や件数など内部処理は回答本文で説明しないでください。URL、Markdown、根拠番号、モデル名は読み上げないでください。`;

const GROUNDED_PC_PROMPT = `${GROUNDED_PROMPT}
パソコン関連では、用途・予算・保証・性能など判断を左右する項目を優先してください。価格・在庫・現行仕様は今回の根拠にある範囲だけ述べてください。`;

function connectionFrom(context) { return context?.connection || context || null; }
function send(connection, payload) { try { connection?.send(JSON.stringify(payload)); } catch {} }
function serveScript(source) {
  return new Response(source, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
}
function sessionAffinity(context) {
  const source = String(connectionFrom(context)?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v32-${source}` : '';
}
function quickCasualReply(text) {
  const value = String(text || '').trim().replace(/[！!。．.]+$/u, '');
  if (/^(こんにちは|こんにちわ|やあ|どうも|もしもし)$/u.test(value)) return 'こんにちは。今日はどのようなご相談ですか？';
  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。今日はどのようなご相談ですか？';
  if (/^こんばんは$/u.test(value)) return 'こんばんは。今日はどのようなご相談ですか？';
  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。続きがあればそのまま話してください。';
  return '';
}
function shouldSearchV32(transcript, history) {
  const text = String(transcript || '').trim();
  if (HARD_SEARCH_RE.test(text)) return { search: true, reason: 'current-or-lookup-required' };
  if (GENERAL_ADVICE_RE.test(text) && !HARD_SEARCH_RE.test(text)) return { search: false, reason: 'contextual-advice' };
  const base = groundingDecisionV22(text, history);
  // Short follow-up questions are often advice about the subject already being discussed.
  // Only inherit a search requirement when the current utterance itself asks for a lookup.
  if (text.length <= 28 && QUALITY_INTENT_RE.test(text) && !HARD_SEARCH_RE.test(text)) return { search: false, reason: 'contextual-reasoning' };
  return { search: base.search, reason: base.reason };
}
function nonGroundedMessages(history, transcript) {
  const combined = [...(Array.isArray(history) ? history.slice(-14) : []), { role: 'user', content: transcript }];
  const pc = PC_TOPIC_RE.test(combined.map((x) => String(x?.content || '')).join(' '));
  return [{ role: 'system', content: pc ? PC_PROMPT : GENERAL_PROMPT }, ...combined];
}
function evidenceMessages(history, transcript, result) {
  const allText = `${result?.resolvedQuestion || transcript} ${(history || []).slice(-8).map((x) => x?.content || '').join(' ')}`;
  const pc = PC_TOPIC_RE.test(allText);
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, pc ? 8 : 7) : [];
  const compact = sources.map((item, index) => {
    const excerpt = String(item?.excerpt || item?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, pc ? 1000 : 800);
    return `[${index + 1}] ${String(item?.title || '').slice(0, 180)}\n${String(item?.url || '').slice(0, 600)}\n${excerpt}`;
  }).join('\n\n');
  return [
    { role: 'system', content: pc ? GROUNDED_PC_PROMPT : GROUNDED_PROMPT },
    ...(Array.isArray(history) ? history.slice(-12) : []),
    { role: 'user', content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(有効な根拠なし)'}` },
  ];
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV31 {
  trackAssistant(iterable, context, tier, userText = '') {
    const self = this;
    const connection = connectionFrom(context);
    const user = String(userText || '').trim();
    if (user) recordConversationUser(connection, user);
    const startedAt = Date.now();

    return (async function* () {
      const runtime = self.runtimeFor(connection);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
      send(connection, { type: 'turn_trace', phase: 'received', message: '入力を受付', elapsedMs: 0 });
      send(connection, { type: 'turn_trace', phase: 'routing', message: '会話文脈を適用して回答経路を判断', elapsedMs: Date.now() - startedAt });
      send(connection, { type: 'model_route', tier, model: GLM_CONVERSATION_MODEL_V32 });
      if (!String(tier || '').includes('search') && !String(tier || '').includes('grounded')) {
        send(connection, { type: 'turn_trace', phase: 'model_waiting', message: 'GLM-5.3 Flashで回答を生成', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
      }

      let failed = false;
      try {
        for await (const delta of iterable) {
          const value = String(delta || '').trim();
          if (!value) continue;
          runtime.currentAssistantText += value;
          send(connection, { type: 'turn_trace', phase: 'model_done', message: '自然文の回答生成が完了', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
          yield value;
        }
      } catch (error) {
        failed = true;
        send(connection, { type: 'turn_trace', phase: 'model_retry', message: 'GLMの予備経路で回答を復旧', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
      }

      if (failed && !runtime.currentAssistantText && !String(tier || '').includes('search') && !String(tier || '').includes('grounded')) {
        try {
          const history = self.getTalkSysHistory(connection);
          for await (const text of streamGlmConversationV32(self.env.AI, nonGroundedMessages(history, userText), {
            signal: context?.signal, maxTokens: 320, hedgeDelayMs: 900, attemptTimeoutMs: 4000, reasoningEffort: 'low', sessionAffinity: `${sessionAffinity(context)}-recovery`,
          })) {
            runtime.currentAssistantText = String(text || '').trim();
            if (runtime.currentAssistantText) {
              send(connection, { type: 'turn_trace', phase: 'model_done', message: 'GLM予備経路で回答を復旧', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
              yield runtime.currentAssistantText;
            }
          }
        } catch {}
      }

      if (!runtime.currentAssistantText) {
        runtime.currentAssistantText = 'すみません、今の回答生成だけ復旧できませんでした。質問内容は残っているので、そのまま「続けて」と言ってください。';
        send(connection, { type: 'turn_trace', phase: 'failed', message: '回答生成の復旧に失敗', elapsedMs: Date.now() - startedAt });
        yield runtime.currentAssistantText;
      }

      const clean = cleanSpeechText(runtime.currentAssistantText);
      if (clean) runtime.lastAssistantText = clean;
      self.rememberConversationTurn(context, userText, clean);
      send(connection, { type: 'turn_trace', phase: 'done', message: '回答を完了', elapsedMs: Date.now() - startedAt });
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
    })();
  }

  normalConversationTurn(transcript, context, history) {
    const quick = quickCasualReply(transcript);
    if (quick) return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v32', transcript);
    const contextText = `${(history || []).slice(-8).map((x) => x?.content || '').join(' ')} ${transcript}`;
    const quality = PC_TOPIC_RE.test(contextText) || QUALITY_INTENT_RE.test(String(transcript || '')) || String(transcript || '').length >= 100;
    return this.trackAssistant(streamGlmConversationV32(this.env.AI, nonGroundedMessages(history, transcript), {
      signal: context?.signal,
      maxTokens: quality ? 360 : 280,
      hedgeDelayMs: quality ? 1650 : 1450,
      attemptTimeoutMs: quality ? 4400 : 3900,
      reasoningEffort: 'low',
      sessionAffinity: sessionAffinity(context),
    }), context, quality ? 'glm-natural-quality-v32' : 'glm-natural-live-v32', transcript);
  }

  mandatoryGroundedTurn(transcript, context, history) {
    const self = this;
    return (async function* () {
      const connection = connectionFrom(context);
      const startedAt = Date.now();
      const result = await self.collectSearchEvidence(transcript, transcript, history, context);
      send(connection, { type: 'turn_trace', phase: 'model_waiting', message: '確認した根拠をGLMで自然な回答に整理', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
      send(connection, { type: 'search_trace', phase: 'answering', resolvedQuestion: result.resolvedQuestion, queries: result.queries, evidenceCount: result.sources?.length || 0, sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })), message: '確認した根拠から回答を構成' });
      if (!result.sources?.length) {
        yield '今の条件では確かな根拠まで絞れませんでした。対象か条件をもう1つ教えてください。';
        send(connection, { type: 'search_trace', phase: 'done', resolvedQuestion: result.resolvedQuestion, queries: result.queries, evidenceCount: 0, sources: [], message: '追加条件を確認' });
        return;
      }
      const messages = evidenceMessages(history, transcript, result);
      try {
        yield* streamGlmConversationV32(self.env.AI, messages, { signal: context?.signal, maxTokens: PC_TOPIC_RE.test(String(result.resolvedQuestion || transcript)) ? 420 : 340, hedgeDelayMs: 1500, attemptTimeoutMs: 4300, reasoningEffort: 'low', sessionAffinity: sessionAffinity(context) });
      } catch {
        send(connection, { type: 'turn_trace', phase: 'model_retry', message: '根拠を保持したままGLM回答を再生成', model: GLM_CONVERSATION_MODEL_V32, elapsedMs: Date.now() - startedAt });
        yield* streamGlmConversationV32(self.env.AI, messages, { signal: context?.signal, maxTokens: 320, hedgeDelayMs: 900, attemptTimeoutMs: 3900, reasoningEffort: 'low', sessionAffinity: `${sessionAffinity(context)}-grounded-recovery` });
      }
      send(connection, { type: 'search_trace', phase: 'done', resolvedQuestion: result.resolvedQuestion, queries: result.queries, evidenceCount: result.sources?.length || 0, sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })), message: '回答を完了' });
    })();
  }

  async onTurn(transcript, context) {
    const connection = connectionFrom(context);
    const history = this.getTalkSysHistory(connection);
    const decision = shouldSearchV32(transcript, history);
    send(connection, { type: 'grounding_policy', revision: 'contextual-risk-grounding-v32', search: decision.search, reason: decision.reason, riskTags: decision.search ? [decision.reason] : [] });
    if (decision.search) return this.trackAssistant(this.mandatoryGroundedTurn(transcript, context, history), context, 'grounded-search-v32', transcript);
    return this.normalConversationTurn(transcript, context, history);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V32);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V32);
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV31.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({ ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationModel: GLM_CONVERSATION_MODEL_V32,
        conversationModelFallback: GLM_CONVERSATION_MODEL_V32,
        glmOnlyConversation: true,
        ttsPrimary: '@cf/myshell-ai/melotts',
        ttsFallback: null,
        conversationOrchestrator: 'coherent-complete-glm-with-bounded-same-model-hedge-v32',
        rawTokenStreamingToClient: false,
        coherentReplyDelivery: true,
        sameModelHedgedRecovery: true,
        naturalReplyLengthPolicy: true,
        conciseRepliesByDefault: false,
        processingTraceAllTurns: true,
        processingTraceShowsChainOfThought: false,
        groundingPolicy: 'contextual-risk-grounding-v32',
        factualQuestionsSearchByDefault: false,
        contextualAdviceAvoidsUnnecessarySearch: true,
        productionArchitecture: 'Whisper -> GLM-5.3-Flash coherent answer -> MeloTTS',
      }, { headers: { 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }
    return workerV31.fetch(request, env, ctx);
  },
};
