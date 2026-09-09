import { TALK_CLIENT_V41 } from './talk-client-v41.js';

const REVISION='talksys-v42-search-judgment-persistent-logs';

let client=TALK_CLIENT_V41
  .replaceAll('talksys-v41-safety-search-backchannel',REVISION)
  .replaceAll('TalkSys v41 起動','TalkSys v42 起動');

client=client.replace(
  "let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0, fallbackAudio=null, fallbackSource=null, lastPlanMs=0, lastSearchPlan='', lastVoiceCount=0, lastJaVoiceCount=0, ttsStrategy='未判定';",
  "let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0, fallbackAudio=null, fallbackSource=null, lastPlanMs=0, lastSearchPlan='', lastVoiceCount=0, lastJaVoiceCount=0, ttsStrategy='未判定', talkSessionId=(globalThis.crypto&&typeof crypto.randomUUID==='function'?crypto.randomUUID():'talk-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));",
);

client=client.replace(
  "body:JSON.stringify({text,history:previous,searchTrace})",
  "body:JSON.stringify({text,history:previous,searchTrace,sessionId:talkSessionId})",
);

client=client.replaceAll(
  "const payload={text,history:previous,searchTrace,searchPlan:plan||null};",
  "const payload={text,history:previous,searchTrace,searchPlan:plan||null,sessionId:talkSessionId};",
);

client=client.replace(
  "headers:{'content-type':'audio/wav'},body:buffer",
  "headers:{'content-type':'audio/wav','x-talksys-session':talkSessionId},body:buffer",
);

client=client.replace(
  "tts:'日本語専用 / '+lastVoiceName,ttsStrategy,voiceCount:lastVoiceCount,jaVoiceCount:lastJaVoiceCount,planMs:lastPlanMs",
  "tts:'日本語専用 / '+lastVoiceName,sessionId:talkSessionId,ttsStrategy,voiceCount:lastVoiceCount,jaVoiceCount:lastJaVoiceCount,planMs:lastPlanMs",
);

export const TALK_CLIENT_V42=client;
