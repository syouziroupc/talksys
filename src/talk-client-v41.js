import { TALK_CLIENT_V40 } from './talk-client-v40.js';

const REVISION='talksys-v41-safety-search-backchannel';

let client=TALK_CLIENT_V40
  .replaceAll('talksys-v40-japanese-native-fallback',REVISION)
  .replaceAll('TalkSys v40 起動','TalkSys v41 起動');

client=client.replace(
  "const searching=(ack?ack+' ':'')+'条件に合う情報を調べます。';",
  "const searching=ack||'少し調べます。';",
);

client=client.replace(
  "log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / planner='+(j.planner||plan.planner||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));",
  "log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / planner='+(j.planner||plan.planner||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':'')+(j.searchPasses?' / passes='+j.searchPasses:''));",
);

export const TALK_CLIENT_V41=client;
