from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

UI = r'''export const UI_REVISION = 'talksys-v45-ui-restored-20260911';

export const TALK_HTML_V45 = `<!doctype html>
<html lang="ja" data-ui-revision="${UI_REVISION}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>TalkSys</title>
  <style>
    :root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#eef1f6}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#edf1f7 0,#f7f8fa 38%,#eef1f6 100%)}button,input{font:inherit}
    .app{max-width:920px;min-height:100dvh;margin:0 auto;background:#fff;display:flex;flex-direction:column;box-shadow:0 0 0 1px rgba(17,24,39,.04),0 18px 60px rgba(15,23,42,.08)}
    .top{position:sticky;top:0;z-index:10;padding:15px 18px;background:rgba(255,255,255,.94);backdrop-filter:blur(14px);border-bottom:1px solid #e6e9ef;display:flex;align-items:center;gap:12px}
    .brand{font-size:21px;font-weight:900;letter-spacing:-.02em}.mode{font-size:12px;color:#667085;margin-top:2px}.status{margin-left:auto;font-size:13px;font-weight:800;color:#344054}
    .hero{padding:14px 18px 13px;border-bottom:1px solid #edf0f4;background:#fafbfc}.hero-title{font-weight:850;font-size:14px}.hero-copy{margin-top:5px;color:#667085;font-size:12px;line-height:1.55}
    .chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:750}.chip strong{color:#1d2939}.dot{width:7px;height:7px;border-radius:50%;background:#12b76a}.dot.wait{background:#f79009}
    .chat{flex:1;min-height:420px;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:10px;background:#fff}.msg{max-width:86%;padding:11px 14px;border-radius:15px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere}.user{align-self:flex-end;background:#172033;color:#fff;border-bottom-right-radius:5px}.assistant{align-self:flex-start;background:#f2f4f7;color:#1d2939;border-bottom-left-radius:5px}
    .controls{padding:14px 18px 16px;border-top:1px solid #e7eaf0;background:#fff}.mic{width:100%;border:0;border-radius:13px;padding:14px 16px;background:#172033;color:#fff;font-weight:850;cursor:pointer;min-height:52px}.mic.on{background:#b42318}.mic:focus-visible,.send:focus-visible,.test:focus-visible,input:focus-visible{outline:3px solid rgba(47,128,237,.25);outline-offset:2px}
    .form{display:flex;gap:8px;margin-top:10px}.input{flex:1;min-width:0;border:1px solid #d0d5dd;border-radius:11px;padding:11px 12px;font-size:16px}.send{border:1px solid #172033;background:#fff;color:#172033;border-radius:11px;padding:0 16px;font-weight:800;cursor:pointer}.hint{margin:8px 2px 0;color:#667085;font-size:11px;line-height:1.5}
    .debug{border-top:1px solid #e7eaf0;padding:0 18px 18px;background:#fbfcfd}.debug summary{cursor:pointer;padding:13px 0;font-weight:850;font-size:13px}.grid{display:grid;grid-template-columns:150px 1fr;gap:5px 10px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.key{color:#667085}.log{margin-top:10px;max-height:210px;overflow:auto;background:#101828;color:#d0d5dd;border-radius:10px;padding:10px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.test{margin-top:10px;border:1px solid #d0d5dd;background:#fff;border-radius:9px;padding:8px 10px;font-weight:750;cursor:pointer}
    @media(max-width:640px){.app{max-width:none;box-shadow:none}.top{padding:12px}.brand{font-size:18px}.hero{padding:12px}.chat{padding:12px;min-height:380px}.msg{max-width:94%}.controls{padding:12px}.grid{grid-template-columns:112px 1fr}.status{font-size:12px}}
  </style>
</head>
<body>
<main class="app">
  <header class="top">
    <div><div class="brand">TalkSys</div><div class="mode">電話相談・音声実証 v45</div></div>
    <div id="status" class="status" aria-live="polite">停止中</div>
  </header>
  <section class="hero">
    <div class="hero-title">検索強化版と安定したマイク経路を統合</div>
    <div class="hero-copy">現在情報はv45のAPI優先・根拠重視ルータで確認します。音声はWebSocket Agentを使わず、ブラウザ内VADからHTTP文字起こしへ送ります。</div>
    <div class="chips">
      <span class="chip"><span class="dot"></span><strong>音声</strong> HTTP + 適応VAD</span>
      <span class="chip"><span class="dot"></span><strong>回答</strong> v45 unified router</span>
      <span id="phone-provider" class="chip"><span class="dot wait"></span><strong>Foonz</strong> 電話網連携準備中</span>
    </div>
  </section>
  <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">マイク会話を開始してください。外で話せない場合は、下の非常用文字入力も同じ会話として使えます。</div></section>
  <section class="controls">
    <button id="mic" class="mic" type="button">マイク会話を開始</button>
    <form id="form" class="form"><input id="input" class="input" autocomplete="off" placeholder="非常用の文字入力" aria-label="非常用の文字入力"><button class="send" type="submit">送信</button></form>
    <div class="hint">同じ通話内の文脈は引き継ぎます。Foonzの一般電話網接続はブラウザ音声実証とは分離して扱います。</div>
  </section>
  <details class="debug"><summary>デバッグ画面</summary><div id="diag" class="grid"></div><button id="tts-test" class="test" type="button">日本語TTSをテスト</button><div id="log" class="log"></div></details>
</main>
<script src="/talk-v45.js"></script>
<script>
fetch('/telephony-health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){var n=document.getElementById('phone-provider');if(!n)return;if(d&&d.connected===true){n.innerHTML='<span class="dot"></span><strong>Foonz</strong> 接続済み';}else{n.innerHTML='<span class="dot wait"></span><strong>Foonz</strong> 電話網連携準備中';}}).catch(function(){});
</script>
</body>
</html>`;
'''

CLIENT = r'''import { TALK_CLIENT_V43 } from './talk-client-v43.js';

export const CLIENT_REVISION = 'talksys-v45-http-adaptive-vad';

let client = TALK_CLIENT_V43
  .replaceAll('talksys-v43-smoke-weather-adaptive-vad', CLIENT_REVISION)
  .replaceAll('TalkSys v43 起動', 'TalkSys v45 起動');

client = client.replace(
  "'use strict';",
  "'use strict';\\nwindow.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';",
);

export const TALK_CLIENT_V45 = client;
export const __test = {
  revision: CLIENT_REVISION,
  httpTranscribe: client.includes('/api/transcribe'),
  httpTurns: client.includes('/api/turn'),
  adaptiveNoise: client.includes('noiseBoost'),
  ambientCalibration: client.includes('calibrationUntil'),
  legacyWebSocket: /new\\s+WebSocket|\\/agents\\//.test(client),
};
'''

STT = r'''export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const STT_REVISION = 'talksys-v45-hardened-whisper';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-stt-revision': STT_REVISION,
    },
  });
}

function clean(value, max = 1600) {
  return String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
}

function base64FromBytes(bytes) {
  let out = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  return btoa(out);
}

function ascii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

export function analyzeWav(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
    let offset = 12, format = 0, channels = 0, sampleRate = 0, bits = 0, dataOffset = -1, dataSize = 0;
    while (offset + 8 <= view.byteLength) {
      const id = ascii(view, offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8;
      if (id === 'fmt ' && size >= 16 && body + 16 <= view.byteLength) {
        format = view.getUint16(body, true); channels = view.getUint16(body + 2, true); sampleRate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true);
      } else if (id === 'data') {
        dataOffset = body; dataSize = Math.min(size, Math.max(0, view.byteLength - body)); break;
      }
      offset = body + size + (size & 1);
    }
    if (format !== 1 || channels < 1 || bits !== 16 || sampleRate < 8000 || dataOffset < 0 || dataSize < 2 * channels) return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
    const sampleCount = Math.floor(dataSize / (2 * channels)), frameSamples = Math.max(1, Math.round(sampleRate * .02));
    let sum = 0, peak = 0, activeFrames = 0, totalFrames = 0, frameSum = 0, frameN = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      let mono = 0;
      for (let c = 0; c < channels; c += 1) mono += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
      mono /= channels;
      const a = Math.abs(mono); sum += mono * mono; if (a > peak) peak = a; frameSum += mono * mono; frameN += 1;
      if (frameN >= frameSamples || i === sampleCount - 1) {
        const frameRms = Math.sqrt(frameSum / Math.max(1, frameN)); if (frameRms >= 0.006) activeFrames += 1; totalFrames += 1; frameSum = 0; frameN = 0;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, sampleCount)), durationMs = sampleCount / sampleRate * 1000, activeRatio = totalFrames ? activeFrames / totalFrames : 0, activeMs = activeFrames * 20;
    return { valid: true, durationMs, rms, peak, activeMs, activeRatio, sampleRate, channels };
  } catch {
    return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
  }
}

export function weakSpeechSignal(metrics) {
  return !metrics?.valid || metrics.durationMs < 260 || metrics.peak < 0.010 || metrics.rms < 0.0018 || metrics.activeMs < 120 || metrics.activeRatio < 0.06;
}

export function isLikelySttHallucination(text, metrics) {
  const value = clean(text, 500);
  if (!value) return true;
  if (/^(?:ご視聴ありがとうございました|ご清聴ありがとうございました|最後までご視聴ありがとうございました|チャンネル登録(?:を)?(?:お願い(?:します|いたします)|よろしくお願いします)|字幕(?:をご覧いただき)?ありがとうございました)[。．.!！?？]*$/u.test(value)
      && (!metrics?.valid || metrics.rms < 0.010 || metrics.activeMs < 650 || metrics.activeRatio < 0.24)) return true;
  if (/^(?:えー|あー|うー|んー|…|\\.\\.\\.)$/u.test(value) && weakSpeechSignal(metrics)) return true;
  return false;
}

export async function transcribeV45(request, env) {
  const started = Date.now();
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength < 800) return json({ ok: false, error: 'audio too short', rejected: 'audio-too-short' }, 400);
  if (buffer.byteLength > 8_000_000) return json({ ok: false, error: 'audio too large' }, 413);

  const metrics = analyzeWav(buffer);
  const signal = {
    durationMs: Math.round(metrics.durationMs || 0),
    rms: Number((metrics.rms || 0).toFixed(5)),
    peak: Number((metrics.peak || 0).toFixed(5)),
    activeMs: Math.round(metrics.activeMs || 0),
    activeRatio: Number((metrics.activeRatio || 0).toFixed(3)),
  };
  if (weakSpeechSignal(metrics)) return json({ ok: false, error: 'no speech detected', rejected: 'weak-speech-signal', elapsedMs: Date.now() - started, signal }, 422);

  try {
    const result = await env.AI.run(STT_MODEL, {
      audio: base64FromBytes(new Uint8Array(buffer)),
      task: 'transcribe',
      language: 'ja',
      vad_filter: true,
      beam_size: 5,
      condition_on_previous_text: false,
      no_speech_threshold: 0.48,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.8,
      hallucination_silence_threshold: 0.5,
    });
    const text = clean(result?.text || result?.transcription_info?.text || result?.transcript || result?.response || '', 1200);
    if (!text) return json({ ok: false, error: 'no speech detected', rejected: 'empty-transcript', elapsedMs: Date.now() - started, signal }, 422);
    if (isLikelySttHallucination(text, metrics)) return json({ ok: false, error: 'hallucinated transcript rejected', rejected: 'hallucination-guard', elapsedMs: Date.now() - started, signal }, 422);
    return json({ ok: true, text, elapsedMs: Date.now() - started, bytes: buffer.byteLength, model: STT_MODEL, revision: STT_REVISION, signal, guard: 'mobile-stt-v45' });
  } catch (error) {
    return json({ ok: false, error: clean(error?.message || error, 240), elapsedMs: Date.now() - started, signal }, 502);
  }
}
'''

TEST = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V45, CLIENT_REVISION } from '../src/talk-client-v45.js';
import { TALK_HTML_V45, UI_REVISION } from '../src/ui-v45.js';
import { STT_MODEL, STT_REVISION, analyzeWav, weakSpeechSignal } from '../src/stt-v45.js';

const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('v45 shell no longer delegates UI or voice to the legacy worker', () => {
  assert.doesNotMatch(worker, /import\(['"]\.\/worker\.js['"]\)|fetchShell\(/);
  assert.doesNotMatch(worker, /routeAgentRequest|@cloudflare\/voice|\/agents\//);
  assert.match(worker, /TALK_HTML_V45/);
  assert.match(worker, /TALK_CLIENT_V45/);
  assert.match(worker, /transcribeV45/);
});

test('v45 microphone client keeps the proven HTTP adaptive-VAD path', () => {
  assert.equal(CLIENT_REVISION, 'talksys-v45-http-adaptive-vad');
  assert.match(TALK_CLIENT_V45, /getUserMedia/);
  assert.match(TALK_CLIENT_V45, /createScriptProcessor/);
  assert.match(TALK_CLIENT_V45, /\/api\/transcribe/);
  assert.match(TALK_CLIENT_V45, /\/api\/turn/);
  assert.match(TALK_CLIENT_V45, /noiseBoost/);
  assert.match(TALK_CLIENT_V45, /calibrationUntil/);
  assert.match(TALK_CLIENT_V45, /雑音候補を自動破棄/);
  assert.doesNotMatch(TALK_CLIENT_V45, /new\s+WebSocket|\/agents\//);
});

test('v45 UI contains current controls and an honest Foonz status', () => {
  assert.equal(UI_REVISION, 'talksys-v45-ui-restored-20260911');
  for (const id of ['chat','status','mic','form','input','diag','log','tts-test','phone-provider']) assert.match(TALK_HTML_V45, new RegExp(`id=["']${id}["']`));
  assert.match(TALK_HTML_V45, /\/talk-v45\.js/);
  assert.match(TALK_HTML_V45, /Foonz/);
  assert.match(TALK_HTML_V45, /電話網連携準備中/);
  assert.doesNotMatch(TALK_HTML_V45, /realtime-voice\.js|voice-fallback\.js|\/agents\//);
});

test('v45 STT keeps signal gating before Whisper', () => {
  assert.equal(STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(STT_REVISION, 'talksys-v45-hardened-whisper');
  const invalid = analyzeWav(new ArrayBuffer(44));
  assert.equal(invalid.valid, false);
  assert.equal(weakSpeechSignal(invalid), true);
});

test('Wrangler stays on the clean non-Durable-Object production entry', () => {
  assert.match(wrangler, /"main"\s*:\s*"src\/worker-v44\.js"/);
  assert.doesNotMatch(wrangler, /"durable_objects"\s*:/);
});

test('production deployment now checks UI and microphone regressions', () => {
  assert.match(deploy, /talksys-v45-http-adaptive-vad/);
  assert.match(deploy, /talksys-v45-ui-restored-20260911/);
  assert.match(deploy, /\/talk-v45\.js/);
  assert.match(deploy, /getUserMedia/);
  assert.match(deploy, /\/api\/transcribe/);
  assert.match(deploy, /Foonz/);
});
'''

DEPLOY = r'''name: Deploy TalkSys production

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: talksys-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment: production
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      PRODUCTION_URL: https://talksys.syouziroupc.workers.dev
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22

      - name: Verify required Cloudflare credentials
        shell: bash
        run: |
          set -euo pipefail
          test -n "${CLOUDFLARE_API_TOKEN:-}"
          test -n "${CLOUDFLARE_ACCOUNT_ID:-}"

      - name: Install dependencies
        shell: bash
        run: |
          set -euo pipefail
          if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

      - name: Validate exact revision
        shell: bash
        run: |
          set -euo pipefail
          find src -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
          npm test
          npx wrangler deploy --dry-run

      - name: Deploy exact validated revision
        shell: bash
        run: npx wrangler deploy

      - name: Verify v45 production contract
        shell: bash
        run: |
          set -euo pipefail
          body=""
          for attempt in $(seq 1 20); do
            body="$(curl -fsS --max-time 20 "$PRODUCTION_URL/voice-health" || true)"
            ok="$(BODY="$body" node -e "let d={};try{d=JSON.parse(process.env.BODY||'{}')}catch{};process.stdout.write(String(Boolean(d.revision==='talksys-v45-formal-api-primary-safe-fallback'&&d.voiceRevision==='talksys-v45-http-adaptive-vad'&&d.uiRevision==='talksys-v45-ui-restored-20260911'&&d.sttRevision==='talksys-v45-hardened-whisper'&&d.voiceArchitecture==='http-turns-client-vad-v45'&&d.adaptiveNoiseVad===true&&d.ambientCalibration===true&&d.legacyWebSocketVoice===false&&d.durableObjectVoice===false&&d.legacyAgentRoute===false&&d.unifiedTurnRouter===true&&d.legacyV43TurnDelegation===false&&d.apiFirst===true&&d.apiParallel===true&&d.groundedEvidenceFallback===true&&d.externalFailureUsesCasualModel===false&&d.modelTimeoutMs===12000&&d.searchDirectorModel==='@cf/qwen/qwen3-30b-a3b-fp8'&&d.searchDefault==='intent-routed-v45')))" )"
            [[ "$ok" == "true" ]] && break
            [[ "$attempt" -eq 20 ]] && { echo "$body"; exit 1; }
            sleep 3
          done
          echo "$body"

      - name: Verify live UI and microphone client
        shell: bash
        run: |
          set -euo pipefail
          page="$(curl -fsS --max-time 20 "$PRODUCTION_URL/")"
          grep -F 'talksys-v45-ui-restored-20260911' <<< "$page"
          grep -F '/talk-v45.js' <<< "$page"
          grep -F 'Foonz' <<< "$page"
          client="$(curl -fsS --max-time 20 "$PRODUCTION_URL/talk-v45.js")"
          grep -F 'getUserMedia' <<< "$client"
          grep -F '/api/transcribe' <<< "$client"
          grep -F '/api/turn' <<< "$client"
          grep -F 'noiseBoost' <<< "$client"
          if grep -E 'new[[:space:]]+WebSocket|/agents/' <<< "$client"; then echo 'legacy websocket voice path returned'; exit 1; fi
          telephony="$(curl -fsS --max-time 20 "$PRODUCTION_URL/telephony-health")"
          TELEPHONY="$telephony" node -e "const d=JSON.parse(process.env.TELEPHONY||'{}');if(d.provider!=='Foonz'||d.connected!==false||d.status!=='planned-not-wired')throw new Error(process.env.TELEPHONY);"

      - name: Production smoke
        shell: bash
        run: |
          set -euo pipefail
          payload='{"text":"12345÷15","history":[]}'
          out="$(curl -fsS --max-time 20 -H 'content-type: application/json' --data "$payload" "$PRODUCTION_URL/api/turn")"
          OUT="$out" node -e "const d=JSON.parse(process.env.OUT||'{}');if(!d.ok||d.route!=='deterministic-v45'||d.search!==false||!String(d.answer||'').includes('823'))throw new Error(process.env.OUT);"

          payload='{"text":"別府市の今日の天気は？","history":[]}'
          out="$(curl -fsS --max-time 75 -H 'content-type: application/json' --data "$payload" "$PRODUCTION_URL/api/turn")"
          OUT="$out" node -e "const d=JSON.parse(process.env.OUT||'{}');const tools=(d.apiSources||[]).map(x=>x.tool);if(!d.ok||d.route!=='api-first-v45'||!tools.includes('jma_weather'))throw new Error(process.env.OUT);"
'''


def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def must_replace(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing anchor: {label}')
    return text.replace(old, new, 1)


write('src/ui-v45.js', UI)
write('src/talk-client-v45.js', CLIENT)
write('src/stt-v45.js', STT)
write('tests/v45-shell-regression.test.mjs', TEST)
write('.github/workflows/deploy.yml', DEPLOY)

worker_path = ROOT / 'src/worker-v44.js'
worker = worker_path.read_text(encoding='utf-8')

imports = """import { TALK_CLIENT_V45, CLIENT_REVISION } from './talk-client-v45.js';\nimport { TALK_HTML_V45, UI_REVISION } from './ui-v45.js';\nimport { transcribeV45, STT_MODEL, STT_REVISION } from './stt-v45.js';\n"""
if "from './talk-client-v45.js'" not in worker:
    anchor = "import { publicShoppingApiRegistry, SHOPPING_API_REVISION } from './free-shopping-api-v45.js';\n"
    worker = must_replace(worker, anchor, anchor + imports, 'v45 shell imports')

old_shell = re.compile(r"\nasync function fetchShell\(request, env, ctx\) \{.*?\n\}\n\nasync function parseJsonClone\(response\) \{.*?\n\}\n", re.S)
new_shell = r'''
function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-revision': REVISION,
      'x-talksys-ui-revision': UI_REVISION,
    },
  });
}

function scriptResponse(script) {
  return new Response(script, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-revision': REVISION,
      'x-talksys-voice-revision': CLIENT_REVISION,
    },
  });
}
'''
if old_shell.search(worker):
    worker = old_shell.sub('\n' + new_shell.strip() + '\n', worker, count=1)
elif 'function htmlResponse(html)' not in worker:
    raise SystemExit('missing anchor: legacy fetchShell block')

health_pattern = re.compile(
    r"    if \(request\.method === 'GET' && url\.pathname === '/voice-health'\) \{.*?\n    \}\n\n    if \(request\.method === 'POST' && url\.pathname === '/api/plan'\) \{",
    re.S,
)
health_replacement = r'''    if (request.method === 'GET' && url.pathname === '/') return htmlResponse(TALK_HTML_V45);
    if (request.method === 'GET' && ['/talk-v45.js', '/talk-v43.js', '/talk-v42.js'].includes(url.pathname)) return scriptResponse(TALK_CLIENT_V45);
    if (request.method === 'POST' && url.pathname === '/api/transcribe') return transcribeV45(request, env);

    if (request.method === 'GET' && url.pathname === '/telephony-health') {
      return json({
        ok: true,
        provider: 'Foonz',
        integration: 'external-telephony-gateway',
        status: 'planned-not-wired',
        connected: false,
        browserVoiceIndependent: true,
        note: 'Foonz gateway credentials and a production bridge are not present in this repository. Browser voice remains the active verification path.',
      });
    }

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      return json({
        ok: true,
        revision: REVISION,
        voiceRevision: CLIENT_REVISION,
        uiRevision: UI_REVISION,
        sttRevision: STT_REVISION,
        sttModel: STT_MODEL,
        voiceArchitecture: 'http-turns-client-vad-v45',
        adaptiveNoiseVad: true,
        ambientCalibration: true,
        falseNoiseLearning: true,
        legacyWebSocketVoice: false,
        durableObjectVoice: false,
        legacyAgentRoute: false,
        telephonyProvider: 'Foonz',
        telephonyStatus: 'planned-not-wired',
        unifiedTurnRouter: true,
        legacyV43TurnDelegation: false,
        localDeterministic: true,
        modelTimeoutMs: MODEL_TIMEOUT_MS,
        modelTimeoutFallback: true,
        groundedEvidenceFallback: true,
        externalFailureUsesCasualModel: false,
        ambiguityGate: true,
        explicitNoExternalGuard: true,
        inputCanonicalization: 'NFKC+spoken-ja',
        webSearch: false,
        webRetrieval: true,
        webSearchPolicy: 'formal-api-and-direct-primary-v45',
        webSearchEngine: 'none-general; formal-api+direct-primary',
        generalWebSearchProvider: 'none',
        generalWebSearchDisabledReason: 'previous RSS provider failed relevance and site-restriction diagnostics',
        generalWebScraping: false,
        bingRssEnabled: false,
        searchRevision: SEARCH_V44_REVISION,
        weatherDirect: 'jma-api-first-with-met-norway-fallback',
        apiFirst: true,
        apiParallel: true,
        freeApiRevision: FREE_API_REVISION,
        freeApiRegistry: { ...publicApiRegistry(), ...publicKnowledgeApiRegistry(), ...publicShoppingApiRegistry() },
        shoppingApiRevision: SHOPPING_API_REVISION,
        shoppingApiRegistry: publicShoppingApiRegistry(),
        shoppingApiFirst: true,
        searchDirectorModel: SEARCH_DIRECTOR_MODEL,
        searchQueryPlanner: SEARCH_DIRECTOR_MODEL,
        searchFillerModel: 'none',
        openMeteoExcluded: true,
        searchDefault: 'intent-routed-v45',
        searchMaxQueries: SEARCH_V44_MAX_QUERIES,
        searchMaxRecoveryQueries: SEARCH_V44_MAX_RECOVERY_QUERIES,
        searchMaxTotalQueries: SEARCH_V44_MAX_TOTAL_QUERIES,
        searchMaxRounds: SEARCH_V44_MAX_ROUNDS,
        searchSourceLimit: SEARCH_V44_SOURCE_LIMIT,
        searchQuestionFirstPlanning: true,
        searchGapDrivenFollowups: false,
        searchResearchStateMachine: true,
        searchSequentialDiscovery: true,
        searchQueryResultGate: true,
        searchAuthorityAfterRelevance: true,
        searchTypedResearchStrategy: true,
        searchSourceRoleAware: true,
        searchIndependentSources: true,
        searchEngineRotation: false,
        searchEngineRetry: false,
        searchMaxEngineRetries: SEARCH_V44_MAX_ENGINE_RETRIES,
        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: false,
        searchGeneralWebEnabled: SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,
        searchDirectPrimaryResolver: true,
        searchPartialEvidenceAnswering: true,
        searchStageAwareGate: true,
        searchTotalBudgetMs: SEARCH_V45_TOTAL_BUDGET_MS,
        searchDirectorTimeoutMs: SEARCH_V45_DIRECTOR_TIMEOUT_MS,
        searchHostDiversity: true,
        searchMaxPerHost: SEARCH_V44_MAX_PER_HOST,
        searchProbeConcurrency: SEARCH_V44_PROBE_CONCURRENCY,
        searchSubrequestBudgetAware: true,
        searchExternalSubrequestBaseTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
        searchExternalSubrequestWorstTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
        specializedSearchRoutesPreserved: false,
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/plan') {'''
if health_pattern.search(worker):
    worker = health_pattern.sub(health_replacement, worker, count=1)
elif "url.pathname === '/telephony-health'" not in worker:
    raise SystemExit('missing anchor: legacy voice-health route')

worker = worker.replace(
    '    return wrap(await fetchShell(request, env, ctx));',
    "    return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store', 'x-talksys-revision': REVISION } });",
)
if 'fetchShell(' in worker or "import('./worker.js')" in worker:
    raise SystemExit('legacy shell dependency remains after patch')

worker_path.write_text(worker, encoding='utf-8')
print('v45 UI/voice regression repair applied')
