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
  "if(ack){add('assistant',ack);log('相槌: '+ack);await speak(ack,{resumeable:false});if(seq!==turnSeq)return;}",
  "if(ack)log('非検索ターンの相槌は省略: '+ack);",
);

client=client.replace(
  "searchAnnouncements:true,backchannels:true",
  "searchAnnouncements:true,backchannels:true",
);

export const TALK_CLIENT_V41=client;
