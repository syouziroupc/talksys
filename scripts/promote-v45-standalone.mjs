import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TALK_CLIENT_V43 } from '../src/talk-client-v43.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, v) => fs.writeFileSync(path.join(ROOT, p), v, 'utf8');

const CLIENT_REVISION = 'talksys-v45-standalone-http-adaptive-vad';
let client = String(TALK_CLIENT_V43)
  .replaceAll('talksys-v43-smoke-weather-adaptive-vad', CLIENT_REVISION)
  .replaceAll('TalkSys v43 起動', 'TalkSys v45 起動')
  .replaceAll('talksys-v42-search-judgment-persistent-logs', CLIENT_REVISION)
  .replaceAll('talksys-v41-safety-search-backchannel', CLIENT_REVISION)
  .replaceAll('talksys-v40-japanese-native-fallback', CLIENT_REVISION)
  .replaceAll('talksys-v38-history-search-tts-fallback', CLIENT_REVISION);
if (!client.includes("window.__TALKSYS_CLIENT_REVISION__")) {
  client = client.replace("'use strict';", "'use strict';\nwindow.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';");
}
if (/new\s+WebSocket|\/agents\//.test(client)) throw new Error('legacy websocket/agent remains in materialized v45 client');

const clientModule = `export const CLIENT_REVISION = ${JSON.stringify(CLIENT_REVISION)};\n\nexport const TALK_CLIENT_V45 = ${JSON.stringify(client)};\n\nexport const __test = {\n  revision: CLIENT_REVISION,\n  standalone: true,\n  httpTranscribe: TALK_CLIENT_V45.includes('/api/transcribe'),\n  httpTurns: TALK_CLIENT_V45.includes('/api/turn'),\n  adaptiveNoise: TALK_CLIENT_V45.includes('noiseBoost'),\n  ambientCalibration: TALK_CLIENT_V45.includes('calibrationUntil'),\n  legacyWebSocket: /new\\s+WebSocket|\\/agents\\//.test(TALK_CLIENT_V45),\n};\n`;
write('src/talk-client-v45.js', clientModule);

let log = read('src/log-v42.js')
  .replaceAll('LOG_V42_REVISION', 'LOG_V45_REVISION')
  .replaceAll('talksys-log-v42-d1-private', 'talksys-log-v45-d1-private')
  .replaceAll('talksys-conversation-log-v42', 'talksys-conversation-log-v45');
write('src/log-v45.js', log);

let worker = read('src/worker-v44.js');
worker = worker
  .replace("from './log-v42.js'", "from './log-v45.js'")
  .replace("const REVISION = 'talksys-v45-formal-api-primary-safe-fallback';", "const REVISION = 'talksys-v45-standalone-answer-core';")
  .replace("if (request.method === 'GET' && ['/talk-v45.js', '/talk-v43.js', '/talk-v42.js'].includes(url.pathname)) return scriptResponse(TALK_CLIENT_V45);", "if (request.method === 'GET' && url.pathname === '/talk-v45.js') return scriptResponse(TALK_CLIENT_V45);");

const answerContract = [
  '',
  'const ANSWER_CONTRACT_V45 = `',
  'TalkSys v45回答契約:',
  '- 最初の1文で質問へ直接答える。結論を先延ばしにしない。',
  '- 通常は2〜5文。必要な情報量が多い時だけ伸ばす。電話で聞いて理解できる自然な日本語にする。',
  '- 直前までの会話履歴から対象、用途、予算、条件、省略語を復元し、同じ質問を聞き返さない。',
  '- 不明点があっても安全に合理的な仮定で進められるなら進める。確認質問は答えが大きく変わる時だけ1つに絞る。',
  '- おすすめ・比較では第一候補を明示し、その理由を具体的に述べる。曖昧な「場合による」だけで終わらせない。',
  '- PC相談では、用途・予算・現在機・必要性能・修理/買替のどちらが合理的かを会話から判断し、次の行動を具体化する。',
  '- 現在情報は取得根拠に従う。取得できていない価格、在庫、時刻、法令、ニュース等は捏造しない。',
  '- 外部取得の一部が失敗しても回答全体を止めない。確認済み事実と安定した一般知識を分けて、利用者に役立つ結論まで出す。',
  '- 内部バージョン、ルータ、モデル、検索実装、失敗ログを利用者へ説明しない。',
  '- 不要な免責、長い前置き、同じ内容の言い換え、過剰な箇条書きを避ける。',
  '`;',
  '',
].join('\n');
if (!worker.includes('ANSWER_CONTRACT_V45')) {
  worker = worker.replace('const MODEL_TIMEOUT_MS = 12000;\n', 'const MODEL_TIMEOUT_MS = 12000;\n' + answerContract);
}
worker = worker.replaceAll('CASUAL_PROMPT + extra', 'CASUAL_PROMPT + ANSWER_CONTRACT_V45 + extra');
worker = worker.replaceAll('content: GROUNDED_PROMPT }', 'content: GROUNDED_PROMPT + ANSWER_CONTRACT_V45 }');
worker = worker.replaceAll('content: GROUNDED_PROMPT },', 'content: GROUNDED_PROMPT + ANSWER_CONTRACT_V45 },');
worker = worker.replace(/content:\s*CASUAL_PROMPT\s*\+\s*'\\\n/g, "content: CASUAL_PROMPT + ANSWER_CONTRACT_V45 + '\\\n");
worker = worker.replace('legacyV43TurnDelegation: false,', "legacyV43TurnDelegation: false,\n        legacyRuntimeCutoff: true,\n        runtimeGeneration: 'v45-only',\n        answerContract: 'direct-context-grounded-v45',");
write('src/worker-v45.js', worker);

let wrangler = read('wrangler.jsonc');
wrangler = wrangler
  .replace(/\n\s*\/\/ Historical rollback markers retained for regression contracts:\n\s*\/\/ "main": [^\n]+\n/, '\n  // Production runtime is v45-only. Historical files may remain in the repository but are not reachable from this entrypoint.\n')
  .replace('"main": "src/worker-v44.js"', '"main": "src/worker-v45.js"');
write('wrangler.jsonc', wrangler);

const packagePath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
delete pkg.dependencies?.['@cloudflare/voice'];
delete pkg.dependencies?.['agents'];
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

for (const name of fs.readdirSync(path.join(ROOT, 'tests')).filter((n) => /^v45.*\.test\.mjs$/.test(n))) {
  const p = path.join('tests', name);
  let t = read(p);
  t = t.replaceAll('../src/worker-v44.js', '../src/worker-v45.js');
  t = t.replaceAll('src/worker-v44.js', 'src/worker-v45.js');
  t = t.replaceAll('talksys-v45-http-adaptive-vad', CLIENT_REVISION);
  write(p, t);
}

const legacyTest = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { TALK_CLIENT_V45, CLIENT_REVISION } from '../src/talk-client-v45.js';\n\nconst ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');\nconst worker=fs.readFileSync(path.join(ROOT,'src/worker-v45.js'),'utf8');\nconst wrangler=fs.readFileSync(path.join(ROOT,'wrangler.jsonc'),'utf8');\nconst pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));\n\ntest('production entrypoint is v45-only',()=>{\n  assert.match(wrangler,/\\"main\\"\\s*:\\s*\\"src\\/worker-v45\\.js\\"/);\n  assert.doesNotMatch(worker,/log-v(?:4[0-3]|[0-3]\\d)\\.js|worker-v43|talk-client-v43|talk-client-v42/);\n  assert.match(worker,/from '.\\/log-v45\\.js'/);\n  assert.match(worker,/legacyRuntimeCutoff: true/);\n});\n\ntest('browser client is materialized standalone v45',()=>{\n  const source=fs.readFileSync(path.join(ROOT,'src/talk-client-v45.js'),'utf8');\n  assert.equal(CLIENT_REVISION,'${CLIENT_REVISION}');\n  assert.doesNotMatch(source,/from '.\\/talk-client-v(?:4[0-3]|[0-3]\\d)\\.js'/);\n  assert.doesNotMatch(TALK_CLIENT_V45,/new\\s+WebSocket|\\/agents\\//);\n  assert.match(TALK_CLIENT_V45,/getUserMedia/);\n  assert.match(TALK_CLIENT_V45,/\\/api\\/transcribe/);\n  assert.match(TALK_CLIENT_V45,/\\/api\\/turn/);\n});\n\ntest('legacy voice packages are no longer production dependencies',()=>{\n  assert.equal(pkg.dependencies?.['@cloudflare/voice'],undefined);\n  assert.equal(pkg.dependencies?.agents,undefined);\n});\n\ntest('v45 answer contract is hard-wired into both casual and grounded synthesis',()=>{\n  assert.match(worker,/ANSWER_CONTRACT_V45/);\n  assert.match(worker,/最初の1文で質問へ直接答える/);\n  assert.match(worker,/会話履歴から対象、用途、予算、条件、省略語を復元/);\n  assert.match(worker,/おすすめ・比較では第一候補を明示/);\n  assert.match(worker,/外部取得の一部が失敗しても回答全体を止めない/);\n  assert.match(worker,/GROUNDED_PROMPT \\+ ANSWER_CONTRACT_V45/);\n  assert.match(worker,/CASUAL_PROMPT \\+ ANSWER_CONTRACT_V45/);\n});\n`;
write('tests/v45-no-legacy-runtime.test.mjs', legacyTest);

console.log('Promoted TalkSys to standalone v45 runtime.');
