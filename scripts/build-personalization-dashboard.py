from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing marker: {label}')
    return text.replace(old, new, 1)


def patch(path, replacements):
    p = Path(path)
    text = p.read_text()
    original = text
    for old, new, label in replacements:
        text = replace_once(text, old, new, label)
    if text != original:
        p.write_text(text)


telephony = Path('src/telephony/index.js')
source = telephony.read_text()

source = replace_once(
    source,
    '.historyAssistant{background:#25213a}\n  </style>',
    '.historyAssistant{background:#25213a}.opsCards{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px;margin-top:12px}.opsCard{border:1px solid #2e394d;background:#0d121b;border-radius:10px;padding:12px}.opsLabel{font-size:12px;color:#9eacc0}.opsValue{font-size:20px;font-weight:750;margin-top:4px;overflow-wrap:anywhere}.opsMeta{font-size:12px;color:#9eacc0;margin-top:10px}.opsRows{margin-top:12px;max-height:360px;overflow:auto;border-top:1px solid #293243}.opsRow{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(90px,.6fr) minmax(90px,.5fr) minmax(180px,1fr);gap:10px;padding:10px;border-bottom:1px solid #283245;cursor:pointer;align-items:center}.opsRow:hover{background:#171e2b}.opsState{font-weight:700}.opsError{color:#ff9d9d}@media(max-width:820px){.opsCards{grid-template-columns:repeat(2,minmax(130px,1fr))}.opsRow{grid-template-columns:1fr 1fr}.opsWide{grid-column:1/-1}}\n  </style>',
    'dashboard styles',
)

source = replace_once(
    source,
    '<section id="app" class="hidden"><div class="grid">',
    '<section id="app" class="hidden"><div class="panel"><div class="top"><div><h2 style="margin:0">パーソナライズ運用状況</h2><div class="sub">自動更新の稼働状況、未処理件数、エラーを全番号まとめて確認できます。</div></div><button id="personalizationRefreshBtn">再読込</button></div><div id="personalizationSummary" class="opsCards"><div class="muted">読込中...</div></div><div id="personalizationMeta" class="opsMeta"></div><div id="personalizationOverview" class="opsRows"></div></div><div class="grid">',
    'dashboard markup',
)

source = replace_once(
    source,
    "  async function refresh(){const d=await api('/phone/api/profiles');rows=d.profiles||[];render()}\n",
    "  const whenJst=value=>{if(!value)return '未実行';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})};\n  async function loadPersonalizationOverview(){const summaryRoot=document.getElementById('personalizationSummary'),metaRoot=document.getElementById('personalizationMeta'),listRoot=document.getElementById('personalizationOverview');summaryRoot.innerHTML='<div class=\"muted\">読込中...</div>';metaRoot.textContent='';listRoot.innerHTML='';try{const d=await api('/phone/api/personalization-status');const s=d.summary||{};summaryRoot.innerHTML=[['自動更新',d.enabled?'有効':'無効',d.enabled?'ok':'warn'],['対象番号',Number(s.numbers||0)+'件',''],['未処理',Number(s.pending_messages||0)+'件',Number(s.pending_messages||0)>0?'warn':'ok'],['要確認',Number(s.error_count||0)+'件',Number(s.error_count||0)>0?'warn':'ok']].map(x=>'<div class=\"opsCard\"><div class=\"opsLabel\">'+esc(x[0])+'</div><div class=\"opsValue '+x[2]+'\">'+esc(x[1])+'</div></div>').join('');if(!d.initialized){metaRoot.innerHTML='<span class=\"warn\">自動更新の状態テーブルはまだ初期化されていません。</span>';return}metaRoot.textContent='最終実行: '+whenJst(s.last_run_at)+' / 更新済み番号: '+Number(s.updated_numbers||0)+' / 未処理あり: '+Number(s.pending_numbers||0)+'件';const items=(d.profiles||[]).slice().sort((a,b)=>{const ae=(a.last_error||/error|fail/i.test(String(a.last_status||'')))?1:0,be=(b.last_error||/error|fail/i.test(String(b.last_status||'')))?1:0;if(ae!==be)return be-ae;const ap=Number(a.pending_messages||0),bp=Number(b.pending_messages||0);if(ap!==bp)return bp-ap;return String(b.last_run_at||'').localeCompare(String(a.last_run_at||''))});listRoot.innerHTML=items.length?items.map(x=>{const bad=Boolean(x.last_error)||/error|fail/i.test(String(x.last_status||''));return '<div class=\"opsRow\" data-ops-phone=\"'+esc(x.phone_number)+'\"><div><div class=\"num\">'+esc(x.display_name||x.phone_number)+'</div><div class=\"meta\">'+esc(x.display_name?x.phone_number:'')+' / '+Number(x.call_count||0)+'通話</div></div><div><div class=\"opsState '+(bad?'opsError':'')+'\">'+esc(x.last_status||'never')+'</div><div class=\"meta\">'+esc(x.last_model||'未実行')+'</div></div><div><div>'+Number(x.pending_messages||0)+'件</div><div class=\"meta\">未処理</div></div><div class=\"opsWide\"><div>'+esc(whenJst(x.last_run_at))+'</div><div class=\"meta '+(bad?'opsError':'')+'\">'+esc(x.last_error||'エラーなし')+'</div></div></div>'}).join(''):'<div class=\"muted\" style=\"padding:12px\">対象の電話番号はまだありません。</div>';listRoot.querySelectorAll('[data-ops-phone]').forEach(el=>el.onclick=()=>loadProfile(el.dataset.opsPhone).catch(e=>alert(e.message)))}catch(e){summaryRoot.innerHTML='<div class=\"warn\">状況取得失敗: '+esc(e.message)+'</div>'}}\n  async function refresh(){const d=await api('/phone/api/profiles');rows=d.profiles||[];render();await loadPersonalizationOverview()}\n",
    'dashboard javascript',
)

source = replace_once(
    source,
    "  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('filter').oninput=render;",
    "  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('personalizationRefreshBtn').onclick=()=>loadPersonalizationOverview();document.getElementById('filter').oninput=render;",
    'dashboard refresh button',
)

aggregate_function = r'''
async function personalizationOverview(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const db = env?.TALKSYS_LOG_DB;
  const enabled = /^(?:1|true|yes|on)$/i.test(String(env?.PHONE_MEMORY_ENABLED ?? '').trim());
  const revision = 'talksys-phone-personalization-dashboard-v129-r1';
  try {
    const result = await db.prepare(`WITH callers AS (
        SELECT from_number AS phone_number, MAX(updated_at) AS last_call_at, COUNT(*) AS call_count
        FROM phone_calls WHERE COALESCE(from_number, '') <> '' GROUP BY from_number
      ), numbers AS (
        SELECT phone_number FROM phone_profiles
        UNION
        SELECT phone_number FROM callers
      ), latest_audit_ids AS (
        SELECT phone_number, MAX(id) AS latest_id FROM phone_memory_audit GROUP BY phone_number
      ), latest_audit AS (
        SELECT a.phone_number, a.personalization_added, a.memory_added, a.name_added, a.created_at
        FROM phone_memory_audit a JOIN latest_audit_ids l ON l.latest_id=a.id
      ), message_progress AS (
        SELECT c.from_number AS phone_number,
          SUM(CASE WHEN m.id>COALESCE(s.last_processed_message_id, 0) THEN 1 ELSE 0 END) AS pending_messages,
          MAX(m.id) AS newest_message_id
        FROM phone_calls c
        JOIN phone_messages m ON m.call_id=c.call_id
        LEFT JOIN phone_memory_state s ON s.phone_number=c.from_number
        WHERE COALESCE(c.from_number, '') <> ''
        GROUP BY c.from_number
      )
      SELECT n.phone_number,
        COALESCE(p.display_name, '') AS display_name,
        COALESCE(p.enabled, 1) AS profile_enabled,
        p.updated_at AS profile_updated_at,
        c.last_call_at,
        COALESCE(c.call_count, 0) AS call_count,
        COALESCE(s.last_processed_message_id, 0) AS last_processed_message_id,
        COALESCE(s.last_run_at, '') AS last_run_at,
        COALESCE(s.last_model, '') AS last_model,
        COALESCE(s.last_status, 'never') AS last_status,
        COALESCE(s.last_error, '') AS last_error,
        COALESCE(mp.pending_messages, 0) AS pending_messages,
        COALESCE(mp.newest_message_id, 0) AS newest_message_id,
        COALESCE(a.personalization_added, 0) AS personalization_added,
        COALESCE(a.memory_added, 0) AS memory_added,
        COALESCE(a.name_added, 0) AS name_added,
        COALESCE(a.created_at, '') AS last_audit_at
      FROM numbers n
      LEFT JOIN phone_profiles p ON p.phone_number=n.phone_number
      LEFT JOIN callers c ON c.phone_number=n.phone_number
      LEFT JOIN phone_memory_state s ON s.phone_number=n.phone_number
      LEFT JOIN message_progress mp ON mp.phone_number=n.phone_number
      LEFT JOIN latest_audit a ON a.phone_number=n.phone_number
      ORDER BY COALESCE(c.last_call_at, p.updated_at, '') DESC, n.phone_number ASC
      LIMIT 500`).all();
    const profiles = (result.results || []).map((row) => ({
      ...row,
      call_count: Number(row.call_count || 0),
      last_processed_message_id: Number(row.last_processed_message_id || 0),
      pending_messages: Number(row.pending_messages || 0),
      newest_message_id: Number(row.newest_message_id || 0),
      personalization_added: Number(row.personalization_added || 0),
      memory_added: Number(row.memory_added || 0),
      name_added: Number(row.name_added || 0),
    }));
    let lastRunAt = '';
    let pendingMessages = 0;
    let pendingNumbers = 0;
    let errorCount = 0;
    let updatedNumbers = 0;
    for (const row of profiles) {
      const pending = Number(row.pending_messages || 0);
      pendingMessages += pending;
      if (pending > 0) pendingNumbers += 1;
      if (row.last_run_at) {
        updatedNumbers += 1;
        if (!lastRunAt || String(row.last_run_at) > lastRunAt) lastRunAt = String(row.last_run_at);
      }
      if (String(row.last_error || '').trim() || /error|fail/i.test(String(row.last_status || ''))) errorCount += 1;
    }
    return json({
      ok: true,
      initialized: true,
      revision,
      enabled,
      summary: {
        numbers: profiles.length,
        profile_count: profiles.filter((row) => Boolean(row.profile_updated_at)).length,
        updated_numbers: updatedNumbers,
        pending_numbers: pendingNumbers,
        pending_messages: pendingMessages,
        error_count: errorCount,
        last_run_at: lastRunAt,
      },
      profiles,
    });
  } catch (error) {
    const detail = clean(error?.message || error, 300);
    if (/no such table/i.test(detail)) {
      return json({
        ok: true,
        initialized: false,
        revision,
        enabled,
        summary: { numbers: 0, profile_count: 0, updated_numbers: 0, pending_numbers: 0, pending_messages: 0, error_count: 0, last_run_at: '' },
        profiles: [],
      });
    }
    return json({ ok: false, error: 'phone_personalization_status_failed', detail, revision }, 500);
  }
}
'''

source = replace_once(
    source,
    '\nasync function profileCalls(request, env, phoneNumber) {',
    aggregate_function + '\nasync function profileCalls(request, env, phoneNumber) {',
    'aggregate status api',
)

source = replace_once(
    source,
    "  return pathname === '/phone' || pathname === '/phone-profiles' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip' || pathname === '/phone/api/profiles'\n",
    "  return pathname === '/phone' || pathname === '/phone-profiles' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip' || pathname === '/phone/api/profiles' || pathname === '/phone/api/personalization-status'\n",
    'aggregate route registration',
)

source = replace_once(
    source,
    "  if(request.method==='GET'&&url.pathname==='/phone/api/profiles')return listPhoneProfiles(request,env);\n",
    "  if(request.method==='GET'&&url.pathname==='/phone/api/profiles')return listPhoneProfiles(request,env);\n  if(request.method==='GET'&&url.pathname==='/phone/api/personalization-status')return personalizationOverview(request,env);\n",
    'aggregate route handler',
)

telephony.write_text(source)


test_path = Path('tests/v129-rescue-personalization-web.test.mjs')
test_source = test_path.read_text()
test_source = replace_once(
    test_source,
    "  assert.equal(isTelephonyPath('/phone/api/profiles/%2B819012345678/memory-status'), true);\n  assert.match(source, /id=\"memoryStatus\"/);",
    "  assert.equal(isTelephonyPath('/phone/api/profiles/%2B819012345678/memory-status'), true);\n  assert.equal(isTelephonyPath('/phone/api/personalization-status'), true);\n  assert.match(source, /id=\"personalizationSummary\"/);\n  assert.match(source, /id=\"personalizationOverview\"/);\n  assert.match(source, /personalizationOverview/);\n  assert.match(source, /talksys-phone-personalization-dashboard-v129-r1/);\n  assert.match(source, /id=\"memoryStatus\"/);",
    'dashboard regression assertions',
)

test_path.write_text(test_source)
print('Personalization web dashboard patch applied')
