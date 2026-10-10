from pathlib import Path

p = Path('src/telephony/index.js')
s = p.read_text(encoding='utf-8')

if 'function zipStoreFiles' not in s:
    marker = """function parsedLatencyDetail(value = '') {
  const raw = String(value || '');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

"""
    addition = r"""function zipU16(value) {
  const n = Number(value) >>> 0;
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function zipU32(value) {
  const n = Number(value) >>> 0;
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function zipConcat(parts) {
  const list = (parts || []).map((part) => part instanceof Uint8Array ? part : new Uint8Array(part || []));
  const total = list.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStoreFiles(files = []) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files || []) {
    const nameBytes = encoder.encode(String(file?.name || 'log.jsonl'));
    const dataBytes = file?.content instanceof Uint8Array ? file.content : encoder.encode(String(file?.content ?? ''));
    const crc = zipCrc32(dataBytes);
    const local = zipConcat([
      zipU32(0x04034b50), zipU16(20), zipU16(0), zipU16(0), zipU16(0), zipU16(0),
      zipU32(crc), zipU32(dataBytes.byteLength), zipU32(dataBytes.byteLength),
      zipU16(nameBytes.byteLength), zipU16(0), nameBytes, dataBytes,
    ]);
    const central = zipConcat([
      zipU32(0x02014b50), zipU16(20), zipU16(20), zipU16(0), zipU16(0), zipU16(0), zipU16(0),
      zipU32(crc), zipU32(dataBytes.byteLength), zipU32(dataBytes.byteLength),
      zipU16(nameBytes.byteLength), zipU16(0), zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(offset), nameBytes,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const centralDirectory = zipConcat(centralParts);
  const end = zipConcat([
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(files.length), zipU16(files.length),
    zipU32(centralDirectory.byteLength), zipU32(offset), zipU16(0),
  ]);
  return zipConcat([...localParts, centralDirectory, end]);
}

async function callJsonlContent(env, call) {
  const callId = String(call?.call_id || '');
  const messages = await env.TALKSYS_LOG_DB.prepare('SELECT role, content, created_at FROM phone_messages WHERE call_id=? ORDER BY id ASC LIMIT 500').bind(callId).all();
  const latency = await env.TALKSYS_LOG_DB.prepare('SELECT turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id=? ORDER BY id ASC LIMIT 1200').bind(callId).all();
  const lines = [JSON.stringify({ type: 'call', call })];
  for (const message of messages.results || []) lines.push(JSON.stringify({ type: 'message', ...message }));
  for (const event of latency.results || []) lines.push(JSON.stringify({
    type: 'latency', turn_id: event.turn_id, stage: event.stage,
    elapsed_ms: Number(event.elapsed_ms || 0), detail: parsedLatencyDetail(event.detail), created_at: event.created_at,
  }));
  return `${lines.join('\n')}\n`;
}

"""
    if marker not in s:
        raise SystemExit('parsedLatencyDetail marker not found')
    s = s.replace(marker, marker + addition, 1)

if 'async function recentCallsZip' not in s:
    marker = "\nasync function texmlResponse(request, env) {"
    addition = r"""
async function recentCallsZip(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.round(requested) : 20));
  const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT ?').bind(limit).all();
  const calls = result.results || [];
  if (!calls.length) return json({ ok: false, error: 'no_calls' }, 404);
  const files = [];
  for (const call of calls) {
    const safeId = String(call.call_id || 'call').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'call';
    files.push({ name: `talksys-call-${safeId}.jsonl`, content: await callJsonlContent(env, call) });
  }
  const archive = zipStoreFiles(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new Response(archive, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="talksys-calls-latest-${calls.length}-${stamp}.zip"`,
      'cache-control': 'no-store',
      'x-talksys-export-count': String(calls.length),
    },
  });
}
"""
    if marker not in s:
        raise SystemExit('texmlResponse marker not found')
    s = s.replace(marker, addition + marker, 1)

route_old = "if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);"
route_new = "if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);\n  " + route_old
if "url.pathname==='/phone/api/calls/export.zip'" not in s:
    if route_old not in s:
        raise SystemExit('phone calls route marker not found')
    s = s.replace(route_old, route_new, 1)

ui_old = '<div class="grid"><div class="panel"><h2>着信一覧</h2><div id="calls"></div></div>'
ui_new = '<div class="grid"><div class="panel"><div class="top"><h2>着信一覧</h2><div><select id="batchCount"><option value="10">直近10件</option><option value="20" selected>直近20件</option><option value="50">直近50件</option></select> <button id="batchExportBtn">ログZIP保存</button></div></div><div id="calls"></div></div>'
if 'id="batchExportBtn"' not in s:
    if ui_old not in s:
        raise SystemExit('dashboard call-list marker not found')
    s = s.replace(ui_old, ui_new, 1)

if 'async function downloadBatchExport()' not in s:
    marker = '  async function start(){'
    addition = r"""  async function downloadBatchExport(){const n=Math.max(1,Math.min(50,Number(document.getElementById('batchCount')?.value||20)||20));const r=await fetch('/phone/api/calls/export.zip?limit='+encodeURIComponent(n),{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok)throw new Error('ZIPの取得に失敗しました');const blob=await r.blob();const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='talksys-calls-latest-'+n+'.zip';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000)}
"""
    if marker not in s:
        raise SystemExit('dashboard start marker not found')
    s = s.replace(marker, addition + marker, 1)

bind_old = "document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));if(adminToken)start();"
bind_new = "document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));if(adminToken)start();"
if "getElementById('batchExportBtn').onclick" not in s:
    if bind_old not in s:
        raise SystemExit('dashboard export bind marker not found')
    s = s.replace(bind_old, bind_new, 1)

p.write_text(s, encoding='utf-8')

test = Path('tests/phone-batch-zip-export-v112.test.mjs')
test.write_text(r"""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipStoreFiles } from '../src/telephony/index.js';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('batch phone export produces a valid stored ZIP container', () => {
  const zip = zipStoreFiles([{ name: 'talksys-call-demo.jsonl', content: '{"type":"call"}\n' }]);
  assert.ok(zip instanceof Uint8Array);
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.match(new TextDecoder().decode(zip), /talksys-call-demo\.jsonl/);
});

test('phone dashboard exposes authenticated recent-call ZIP presets', () => {
  assert.match(source, /recentCallsZip/);
  assert.match(source, /adminAuthorized\(request, env\)/);
  assert.match(source, /application\/zip/);
  assert.match(source, /\/phone\/api\/calls\/export\.zip/);
  assert.match(source, /id="batchExportBtn"/);
  assert.match(source, /value="10"/);
  assert.match(source, /value="20" selected/);
  assert.match(source, /value="50"/);
  assert.match(source, /Math\.min\(50/);
});
""", encoding='utf-8')

print('phone batch ZIP patch applied')
