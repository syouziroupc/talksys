import { TALK_CLIENT_V38 } from './talk-client-v38.js';

const REVISION='talksys-v39-japanese-only-grok-tts';

let client=TALK_CLIENT_V38
  .replaceAll('talksys-v38-history-search-tts-fallback',REVISION)
  .replaceAll('TalkSys v38 起動','TalkSys v39 起動')
  .replaceAll('Cloudflare MeloTTS fallback','Grok TTS 日本語 fallback')
  .replaceAll('Cloudflare TTSへフォールバック','Grok TTS日本語へフォールバック')
  .replaceAll("tts:'自動（端末→Cloudflare） / '+lastVoiceName","tts:'日本語専用（端末→Grok） / '+lastVoiceName")
  .replaceAll("log((useServer?'Cloudflare':'端末')+'日本語TTS完了 '","log((useServer?'Grok':'端末')+'日本語TTS完了 '");

export const TALK_CLIENT_V39=client;
