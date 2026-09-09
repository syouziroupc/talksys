import workerV30, { TalkSysVoiceAgent, VOICE_REVISION_V30 } from './worker-v30.js';
import { CLOUDFLARE_LIVE_CLIENT_V30 } from './cloudflare-live-client-v30.js';
import { collectGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import { GROK_CONVERSATION_MODEL_V29 } from './grok-conversation-v29.js';
import { GROK_TTS_MODEL_V29 } from './grok-japanese-tts-v29.js';
import {
  GROK_PHONE_STT_MODEL_V29,
  GROK_PHONE_CODEC_V29,
  GROK_PHONE_SAMPLE_RATE_V29,
  handlePhoneIncoming,
  handlePhoneMedia,
  phoneHealth,
} from './grok-phone-v29.js';

export { TalkSysVoiceAgent };

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION_V30,
    },
  });
}

async function searchSmoke(query, history = []) {
  const started = Date.now();
  try {
    const result = await collectGroundedEvidenceV26(query, history);
    return Response.json({
      ok: Boolean(result.sources?.length),
      revision: SEARCH_TOOL_V26_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceCount: result.sources?.length || 0,
      elapsedMs: result.elapsedMs,
      directTransitError: result.directTransitError || '',
      sources: (result.sources || []).slice(0, 8).map((item) => ({
        title: item.title,
        url: item.url,
        engine: item.engine,
        excerpt: String(item.excerpt || item.snippet || '').slice(0, 500),
      })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      revision: SEARCH_TOOL_V26_REVISION,
      error: String(error?.message || error).slice(0, 240),
      elapsedMs: Date.now() - started,
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

const CONTEXT_SMOKE_HISTORY = [
  { role: 'user', content: 'パソコンの買い替えについて相談したいんですけど' },
  { role: 'user', content: 'YouTube とネットサーフィンぐらいしかしないかな 安いやつがいい' },
  { role: 'user', content: 'どういうところで買うのがいいのかな' },
  { role: 'user', content: 'お店で買いたいな' },
  { role: 'user', content: '中古だったら どこで買うべき？' },
];

const IN_FLIGHT_TRANSIT_HISTORY = [
  { role: 'user', content: '鷺沼から相模大野までの乗換案内が知りたい' },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/phone/incoming' && (request.method === 'GET' || request.method === 'POST')) {
      return handlePhoneIncoming(request, env);
    }
    if (url.pathname === '/phone/media') return handlePhoneMedia(request, env);
    if (request.method === 'GET' && url.pathname === '/phone/health') {
      return Response.json(phoneHealth(env), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V30);
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v30-context') {
      return searchSmoke('神奈川県横浜市でおすすめのお店ある', CONTEXT_SMOKE_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v30-transit-followup') {
      return searchSmoke('どうですか', IN_FLIGHT_TRANSIT_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v30-pc') {
      return searchSmoke('CF-SV8のUSB-C充電対応と主要仕様を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV30.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      const phone = phoneHealth(env);
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION_V30,
        architecture: 'grok-authoritative-browser-and-pstn-v30',
        conversationModel: GROK_CONVERSATION_MODEL_V29,
        conversationModelFallback: null,
        conversationEmergencyFallback: null,
        searchAnswerModel: GROK_CONVERSATION_MODEL_V29,
        multiModelFallback: false,
        sameModelRetryOnce: true,
        qwenActive: false,
        glmActive: false,
        deepSeekActive: false,
        gptOssActive: false,
        ttsPrimary: GROK_TTS_MODEL_V29,
        ttsFallback: null,
        browserSpeechSynthesisEnabled: false,
        typedSpeechUsesGrokTts: true,
        serverAudioAuthoritative: true,
        phoneEnabled: true,
        phoneGateway: phone.transport,
        phoneStt: GROK_PHONE_STT_MODEL_V29,
        phoneInputCodec: GROK_PHONE_CODEC_V29,
        phoneOutputCodec: GROK_PHONE_CODEC_V29,
        phoneSampleRate: GROK_PHONE_SAMPLE_RATE_V29,
        phoneBargeInClear: true,
        phoneTokenConfigured: phone.phoneTokenConfigured,
        phoneNumberConfiguredByTalkSys: false,
        contextualSearchSmokeEndpoint: '/api/search-smoke-v30-context',
        transitFollowupSmokeEndpoint: '/api/search-smoke-v30-transit-followup',
        grokBindingProbeEndpoint: '/api/grok-binding-probe-v30',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION_V30,
        },
      });
    }
    return workerV30.fetch(request, env, ctx);
  },
};
