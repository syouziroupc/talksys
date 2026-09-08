import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const realtime = await readFile(new URL('../src/realtime-voice-client.js', import.meta.url), 'utf8');
const fallback = await readFile(new URL('../src/voice-fallback-client.js', import.meta.url), 'utf8');
const streaming = await readFile(new URL('../src/streaming-workers-ai.js', import.meta.url), 'utf8');
const search = await readFile(new URL('../src/web-search.js', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const stt = await readFile(new URL('../src/finalizable-nova3.js', import.meta.url), 'utf8');
const reranker = await readFile(new URL('../src/search-rerank.js', import.meta.url), 'utf8');

test('voice uses fast live model and DeepSeek V4 Pro grounded model with two-stage fallback', () => {
  assert.match(streaming, /LIVE_VOICE_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(streaming, /GROUNDING_VOICE_MODEL\s*=\s*'@cf\/deepseek-ai\/deepseek-v4-pro-0813'/);
  assert.match(streaming, /GROUNDING_FALLBACK_MODEL\s*=\s*'@cf\/openai\/gpt-oss-120b'/);
  assert.match(streaming, /grounded\s*\?\s*GROUNDING_VOICE_MODEL/);
  assert.match(streaming, /grounded \? GROUNDING_FALLBACK_MODEL : null/);
  assert.match(streaming, /reasoning_effort:\s*null/);
  assert.match(streaming, /enable_thinking:\s*false/);
});

test('final Japanese transcription uses Whisper large v3 turbo accuracy settings', () => {
  assert.match(stt, /FINAL_STT_MODEL\s*=\s*'@cf\/openai\/whisper-large-v3-turbo'/);
  assert.match(stt, /language:\s*this\.config\.language/);
  assert.match(stt, /vad_filter:\s*true/);
  assert.match(stt, /beam_size:\s*this\.config\.beamSize/);
  assert.match(stt, /condition_on_previous_text:\s*false/);
  assert.match(stt, /initial_prompt:\s*this\.config\.initialPrompt/);
  assert.match(source, /sttModel:\s*FINAL_STT_MODEL/);
});

test('casual path allows useful 2 to 4 sentence replies', () => {
  assert.match(source, /原則2〜4文/);
  assert.match(source, /max_tokens:\s*240/);
  assert.match(source, /casualResponseSentences:\s*'2-4'/);
});

test('grounded questions use contextual planning, multi-query retrieval, reranking, and high reasoning answer model', () => {
  assert.match(source, /function\s+groundedChatInput/);
  assert.match(source, /max_completion_tokens:\s*620/);
  assert.match(source, /const\s+searchIntent\s*=\s*!screenIntent\s*&&\s*needsWebSearch\(transcript\)/);
  assert.match(source, /runDeepSearch\(this\.env\.AI,\s*transcript,\s*context\.messages/);
  assert.match(source, /streamWorkersAIText\(this\.env\.AI,\s*LIVE_VOICE_MODEL,\s*input/);
  assert.match(orchestrator, /planSearchQueries/);
  assert.match(orchestrator, /Promise\.all\(searches\)/);
  assert.match(orchestrator, /rerankSearchResults\(ai,\s*rankQuestion,\s*merged,\s*6\)/);
  assert.match(reranker, /@cf\/baai\/bge-reranker-base/);
});

test('short context-dependent follow-ups avoid contextless web search', () => {
  assert.match(search, /function\s+looksContextDependentFollowup/);
  assert.match(search, /どこ/);
  assert.match(search, /大阪は/);
  assert.match(search, /それなら/);
  assert.match(search, /if \(looksContextDependentFollowup\(value\)\) return false/);
});

test('explicit searches can reconstruct omitted context before retrieval', () => {
  assert.match(orchestrator, /heuristicContextQuery/);
  assert.match(orchestrator, /今回の質問を直前の会話から自己完結した検索課題に直し/);
  assert.match(orchestrator, /予算、用途、地域、型番、日時/);
  assert.match(source, /システムが解決した検索課題/);
});

test('grounded answers do not refuse merely because search evidence is irrelevant', () => {
  assert.match(streaming, /回答全体を拒否しない/);
  assert.match(streaming, /目的、予算、対象商品、用途/);
  assert.match(streaming, /検索責任をユーザーへ返す表現は禁止/);
  assert.match(streaming, /最新価格、在庫、営業時間/);
  assert.match(source, /根拠が不足する部分だけを未確認とし、回答全体を拒否しない/);
});

test('search uses small-model natural filler while high-quality search runs', () => {
  assert.match(orchestrator, /SEARCH_FILLER_MODEL\s*=\s*'@cf\/meta\/llama-3\.2-3b-instruct'/);
  assert.match(orchestrator, /generateSearchFiller/);
  assert.match(orchestrator, /えーと、ちょっと見てみますね/);
  assert.match(orchestrator, /うーん、少し確認しますね/);
  assert.match(source, /generateSearchFiller\(this\.env\.AI/);
  assert.match(source, /if \(!searchPending \|\| context\.signal\?\.aborted\) return/);
  assert.match(source, /transient:\s*true/);
  assert.match(source, /searchFillerSpeech:\s*true/);
});

test('LLM response is streamed into early speech chunks', () => {
  assert.match(source, /assistant_stream_start/);
  assert.match(source, /assistant_speech_chunk/);
  assert.match(source, /assistant_stream_end/);
  assert.match(source, /llmStreaming:\s*true/);
  assert.match(source, /incrementalSpeechChunks:\s*true/);
  assert.match(fallback, /talksys:assistant-speech-chunk/);
});

test('typed chat is routed to the same voice agent instance', () => {
  assert.match(fallback, /agents\/talk-sys-voice-agent\/default/);
  assert.match(fallback, /type:\s*'text_message'/);
  assert.match(fallback, /form\.addEventListener\('submit',[\s\S]*true\)/);
  assert.match(fallback, /stopImmediatePropagation\(\)/);
});

test('grounded prompt protects current facts and screen claims without disabling useful recommendations', () => {
  assert.match(source, /現在の固有事実、数値、日付、価格、在庫、時刻、仕様/);
  assert.match(source, /検索結果が1件しかない場合や結果同士が食い違う場合/);
  assert.match(source, /購入先、おすすめ、比較、選び方/);
  assert.match(source, /実際に行っていないPC操作/);
  assert.match(source, /現在画面を断定できるのは/);
});

test('cloud TTS is skipped and device ja-JP streams chunks', () => {
  assert.match(source, /beforeSynthesize\(\)\s*\{\s*return null;/);
  assert.match(source, /cloudTtsDisabled:\s*true/);
  assert.match(source, /ttsPrimary:\s*'device-ja-JP-streamed-chunks'/);
  assert.match(fallback, /speechSynthesis\.speak\(makeUtterance\(text, generation\)\)/);
});

test('40ms capture and safe barge-in are enabled', () => {
  assert.match(realtime, /CHUNK_SAMPLES\s*=\s*640/);
  assert.match(realtime, /SILENCE_MS\s*=\s*520/);
  assert.match(realtime, /TTS_BARGE_FRAMES\s*=\s*4/);
  assert.match(realtime, /function\s+processBargeIn/);
  assert.match(realtime, /talksys:barge-in/);
  assert.match(source, /halfDuplexDuringDeviceTts:\s*false/);
  assert.match(source, /bargeIn:\s*true/);
});

test('assistant echo is filtered after barge-in', () => {
  assert.match(source, /function\s+looksLikeAssistantEcho/);
  assert.match(source, /echoTranscriptFilter:\s*true/);
  assert.match(source, /looksLikeAssistantEcho\(text,\s*recentAssistant\)/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
});

test('voice health exposes v16 deep search architecture', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'cloudflare-live-v16\.0'/);
  assert.match(source, /webSearchPolicy:\s*'contextual-multi-query-high-reasoning'/);
  assert.match(source, /groundedLlmModel:\s*GROUNDING_VOICE_MODEL/);
  assert.match(source, /groundedLlmFallback:\s*GROUNDING_FALLBACK_MODEL/);
  assert.match(source, /searchQueryPlanner:\s*GROUNDING_VOICE_MODEL/);
  assert.match(source, /searchFillerModel:\s*SEARCH_FILLER_MODEL/);
  assert.match(source, /searchReranker:\s*SEARCH_RERANK_MODEL/);
  assert.match(source, /geminiLivePreferredWhenConfigured:\s*true/);
});
