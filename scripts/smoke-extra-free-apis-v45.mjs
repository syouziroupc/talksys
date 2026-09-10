import { runExtraKnowledgeApiIntent } from '../src/free-api-knowledge-extra-v45.js';

const cases = [
  ['e_stat_dashboard','japan_official_stats','別府市の人口を統計で確認して'],
  ['eurostat','eu_official_stats','EUの人口を教えて'],
  ['wikidata','stable_entity_fact','富士山の標高は？'],
];

for (const [tool,intent,text] of cases) {
  const started = Date.now();
  const result = await runExtraKnowledgeApiIntent(intent, text);
  const summary = { tool, ok:result?.ok, reason:result?.reason, elapsedMs:Date.now()-started, data:result?.data };
  console.log('LIVE_API_SMOKE '+JSON.stringify(summary));
  if (!result?.ok || result.tool !== tool) throw new Error(`live ${tool} failed: ${JSON.stringify(summary)}`);
}
