import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function write(path, mutate) {
  const before = fs.readFileSync(path, 'utf8');
  const after = mutate(before);
  if (after === before) throw new Error(`no changes produced for ${path}`);
  fs.writeFileSync(path, after);
}

write('src/integrated-entry.js', (source) => {
  let s = source;
  s = replaceOnce(
    s,
    "export const FALLBACK_CHANNEL_REVISION = 'talksys-v109-fallback-voice-entry-r1';",
    "export const FALLBACK_CHANNEL_REVISION = 'talksys-v109-fallback-voice-entry-r1';\nexport const GROUNDING_ANSWER_REVISION = 'talksys-grounding-answer-v121-r1';",
    'v121 grounding answer revision',
  );

  s = replaceOnce(
    s,
    `function searchedInInteraction(payload = {}) {\n  return interactionQueries(payload).length > 0\n    || interactionSources(payload).length > 0\n    || (Array.isArray(payload?.steps) && payload.steps.some((step) => /^google_search_/.test(String(step?.type || ''))));\n}\n\nfunction isGeminiInteractionsRegionUnavailable(error) {`,
    `function searchedInInteraction(payload = {}) {\n  return interactionQueries(payload).length > 0\n    || interactionSources(payload).length > 0\n    || (Array.isArray(payload?.steps) && payload.steps.some((step) => /^google_search_/.test(String(step?.type || ''))));\n}\n\nexport function groundingEvidenceUsable(report = {}) {\n  if (report?.required !== true) return true;\n  if (report?.searched !== true || Number(report?.sourceCount || 0) < 1) return false;\n  // Missing citation metadata is not the same as missing retrieved evidence.\n  // Keep blocking an explicitly detected unsupported hard claim when citation\n  // spans exist, but do not discard the whole answer merely because Gemini\n  // omitted citation annotations for otherwise sourced search output.\n  if (Number(report?.citationSpanCount || 0) > 0 && Number(report?.unsupportedHardClaimCount || 0) > 0) return false;\n  return true;\n}\n\nexport function evidenceFailureClarification(text = '') {\n  const value = compact(text, 4000);\n  if (isImmediateTransitQuestion(value)) {\n    const hasDirection = /(?:方面|行き|上り|下り|から.{1,50}(?:まで|へ)|(?:まで|へ).{0,20}(?:行|乗))/i.test(value);\n    if (!hasDirection) return '次の電車は行き先によって変わります。どちら方面か、行き先を教えてください。';\n    return '正しい発車時刻を確認するため、出発駅と行き先をもう一度お願いします。';\n  }\n  if (LOCATION_DEPENDENT_RE.test(value)) {\n    return '場所を正確に確認したいです。駅名か市町村名をもう一度お願いします。';\n  }\n  return '正確に確認するため、対象の名前や地域をもう少し具体的に教えてください。';\n}\n\nfunction isGeminiInteractionsRegionUnavailable(error) {`,
    'v121 usable-evidence policy and targeted clarification',
  );

  s = replaceOnce(
    s,
    '  let groundingFailClosed = groundingRequired && !groundingEvidence.passed;',
    '  let groundingFailClosed = groundingRequired && !groundingEvidenceUsable(groundingEvidence);',
    'initial grounding decision uses usable evidence',
  );

  s = replaceOnce(
    s,
    "      }, recoveryEvidence.passed ? 'log' : 'warn');\n      if (recoveryEvidence.passed) {",
    "      }, groundingEvidenceUsable(recoveryEvidence) ? 'log' : 'warn');\n      if (groundingEvidenceUsable(recoveryEvidence)) {",
    'grounding recovery accepts retrieved source evidence without mandatory citation annotations',
  );

  s = replaceOnce(
    s,
    `  if (groundingFailClosed) {\n    interaction = {\n      ...interaction,\n      answer: GROUNDING_FAIL_CLOSED_ANSWER,\n    };\n  }`,
    `  if (groundingFailClosed) {\n    interaction = {\n      ...interaction,\n      answer: evidenceFailureClarification(text),\n    };\n  }`,
    'replace generic fixed refusal after recovery',
  );

  s = replaceOnce(
    s,
    '  groundingFailClosed = groundingRequired && !finalGroundingEvidence.passed;',
    '  groundingFailClosed = groundingRequired && !groundingEvidenceUsable(finalGroundingEvidence);',
    'final grounding decision uses usable evidence',
  );

  s = replaceOnce(
    s,
    `  if (groundingFailClosed) {\n    answer = GROUNDING_FAIL_CLOSED_ANSWER;\n  } else if (remainingPastDepartures.length > 0) {`,
    `  if (groundingFailClosed) {\n    answer = evidenceFailureClarification(text);\n  } else if (remainingPastDepartures.length > 0) {`,
    'replace generic fixed refusal at final exposure gate',
  );

  s = replaceOnce(s, "      ? 'grounding-evidence-fail-closed'", "      ? 'grounding-evidence-clarification'", 'v121 grounding route');
  s = replaceOnce(s, "      ? 'gemini-grounding-evidence-v110'", "      ? 'gemini-grounding-evidence-v121'", 'v121 grounding planner');

  s = replaceOnce(
    s,
    '    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n    groundingEvidencePassed: groundingEvidence.passed,',
    '    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n    groundingAnswerRevision: GROUNDING_ANSWER_REVISION,\n    groundingEvidencePassed: groundingEvidence.passed,',
    'expose v121 grounding answer revision',
  );

  s = replaceOnce(
    s,
    '    groundingFailClosed,\n    temporalTransitGuard: immediateTransit,',
    '    groundingFailClosed,\n    groundingClarification: groundingFailClosed,\n    temporalTransitGuard: immediateTransit,',
    'expose targeted clarification status',
  );

  s = replaceOnce(
    s,
    '  groundingEvidenceReport,\n  isGeminiInteractionsRegionUnavailable,',
    '  groundingEvidenceReport,\n  groundingEvidenceUsable,\n  evidenceFailureClarification,\n  isGeminiInteractionsRegionUnavailable,',
    'export v121 grounding helpers for regression tests',
  );

  return s;
});

write('src/telephony/index.js', (source) => {
  let s = source;
  s = replaceOnce(s, "export const PHONE_PERSONALIZATION_ACTIVE_REVISION = 'talksys-phone-personalization-v120-r1';", "export const PHONE_PERSONALIZATION_ACTIVE_REVISION = 'talksys-phone-personalization-v121-r1';", 'v121 personalization revision');
  s = replaceOnce(s, "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v120-r1';", "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v121-r1';", 'v121 runtime log revision');
  s = replaceOnce(s, "export const PHONE_RELEASE_VERSION = 'v120';", "export const PHONE_RELEASE_VERSION = 'v121';", 'v121 release version');

  s = replaceOnce(
    s,
    'async function listCalls(request, env) {',
    `async function profileCalls(request, env, phoneNumber) {\n  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);\n  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);\n  const phone = profilePhone(phoneNumber);\n  if (!phone) return json({ ok: false, error: 'phone_number_required' }, 400);\n  const url = new URL(request.url);\n  const requested = Number(url.searchParams.get('limit') || 20);\n  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.round(requested) : 20));\n  const result = await env.TALKSYS_LOG_DB.prepare(\`SELECT call_id, from_number, to_number, status, started_at, updated_at, ended_at, last_user_text, last_assistant_text, message_count\n    FROM phone_calls WHERE from_number=? ORDER BY updated_at DESC LIMIT ?\`).bind(phone, limit).all();\n  return json({ ok: true, phone_number: phone, calls: result.results || [] });\n}\n\nasync function listCalls(request, env) {`,
    'caller-scoped phone history API',
  );

  s = replaceOnce(
    s,
    '.newrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}',
    '.newrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}.profileHistory{margin-top:20px;border-top:1px solid #2a3344;padding-top:14px}.historyCall{padding:10px;border:1px solid #293243;border-radius:9px;margin:8px 0;cursor:pointer}.historyCall:hover{background:#171e2b}.historyMessages{margin-top:12px}.historyMsg{padding:9px 10px;border-radius:8px;margin:7px 0;white-space:pre-wrap}.historyUser{background:#1b2b3a}.historyAssistant{background:#25213a}',
    'profile history styles',
  );

  s = replaceOnce(
    s,
    '<p class="muted">電話番号は本人確認には使用しません。秘密情報は保存しないでください。</p></div></div></div></section>',
    '<p class="muted">電話番号は本人確認には使用しません。秘密情報は保存しないでください。</p></div><div class="profileHistory"><div class="top"><h3>電話履歴</h3><span class="muted">直近20件</span></div><div id="profileCallHistory" class="muted">電話番号を選択してください。</div><div id="profileCallMessages" class="historyMessages muted"></div></div></div></div></section>',
    'profile screen call history panel',
  );

  s = replaceOnce(
    s,
    "history.replaceState(null,'','/phone-profiles?phone='+encodeURIComponent(selectedPhone))}",
    "history.replaceState(null,'','/phone-profiles?phone='+encodeURIComponent(selectedPhone));await loadProfileCalls(selectedPhone)}",
    'load caller history with profile',
  );

  s = replaceOnce(
    s,
    '  async function save(){',
    `  async function loadProfileCalls(phone){const root=document.getElementById('profileCallHistory'),detail=document.getElementById('profileCallMessages');root.innerHTML='<div class="muted">読込中...</div>';detail.innerHTML='';const d=await api('/phone/api/profiles/'+encodeURIComponent(phone)+'/calls?limit=20');const calls=d.calls||[];root.innerHTML=calls.length?calls.map(c=>'<div class="historyCall" data-history-call="'+esc(c.call_id)+'"><div class="num">'+esc(c.started_at||'日時不明')+' / '+esc(c.status||'')+'</div><div class="meta">'+Number(c.message_count||0)+'件 / '+esc(c.last_user_text||c.last_assistant_text||'会話なし')+'</div></div>').join(''):'<div class="muted">この番号の電話履歴はありません。</div>';root.querySelectorAll('[data-history-call]').forEach(el=>el.onclick=()=>loadProfileCallMessages(el.dataset.historyCall).catch(e=>{detail.textContent='会話取得失敗: '+e.message}))}\n  async function loadProfileCallMessages(id){const root=document.getElementById('profileCallMessages');root.innerHTML='<div class="muted">会話読込中...</div>';const d=await api('/phone/api/calls/'+encodeURIComponent(id)+'/messages');root.innerHTML=(d.messages||[]).length?(d.messages||[]).map(m=>'<div class="historyMsg '+(m.role==='user'?'historyUser':'historyAssistant')+'"><div class="meta">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at||'')+'</div>'+esc(m.content||'')+'</div>').join(''):'<div class="muted">会話本文はありません。</div>'}\n  async function save(){`,
    'profile history client functions',
  );

  s = replaceOnce(
    s,
    "  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='',selectedPhone='',selectedProfileVersion=0;const auth=()=>({'authorization':'Bearer '+adminToken});",
    "  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='',selectedPhone='',selectedProfileVersion=0,profileDirty=false;const auth=()=>({'authorization':'Bearer '+adminToken});",
    'dirty state for phone history profile editor',
  );

  const oldLoadProfile = "  async function loadProfile(phone){selectedPhone=String(phone||'');const box=document.getElementById('profileBox');if(!selectedPhone){box.classList.add('hidden');selectedProfileVersion=0;return}const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));const p=d.profile||{};selectedProfileVersion=Number(p.version||0);box.classList.remove('hidden');document.getElementById('profilePhone').textContent=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(p.enabled===0?0:1);document.getElementById('profileStatus').textContent=d.exists?'保存済み':'未登録'}";
  const newLoadProfile = "  async function loadProfile(phone,{force=false}={}){const nextPhone=String(phone||'');const box=document.getElementById('profileBox');if(!nextPhone){selectedPhone='';box.classList.add('hidden');selectedProfileVersion=0;profileDirty=false;return}if(profileDirty&&selectedPhone===nextPhone&&!force)return;selectedPhone=nextPhone;const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));if(profileDirty&&selectedPhone===nextPhone&&!force)return;const p=d.profile||{};selectedProfileVersion=Number(p.version||0);box.classList.remove('hidden');document.getElementById('profilePhone').textContent=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(p.enabled===0?0:1);document.getElementById('profileStatus').textContent=d.exists?'保存済み':'未登録';profileDirty=false}";
  s = replaceOnce(s, oldLoadProfile, newLoadProfile, 'dirty-safe profile load');

  const oldSaveProfile = "  async function saveProfile(){if(!selectedPhone)return;const status=document.getElementById('profileStatus');status.textContent='保存中...';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedProfileVersion})});selectedProfileVersion=Number(d.profile?.version||selectedProfileVersion);status.textContent='保存しました';await refreshCalls()}catch(e){if(e.status===409){status.textContent='他の更新と競合しました。再読込します。';await loadProfile(selectedPhone);return}status.textContent='保存失敗: '+e.message}}";
  const newSaveProfile = "  async function saveProfile(){if(!selectedPhone)return;const status=document.getElementById('profileStatus');status.textContent='保存中...';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedProfileVersion})});selectedProfileVersion=Number(d.profile?.version||selectedProfileVersion);profileDirty=false;status.textContent='保存しました';await refreshCalls()}catch(e){if(e.status===409){status.textContent='他の更新と競合しました。再読込します。';profileDirty=false;await loadProfile(selectedPhone,{force:true});return}status.textContent='保存失敗: '+e.message}}";
  s = replaceOnce(s, oldSaveProfile, newSaveProfile, 'dirty-safe profile save');

  const oldLoadMessages = "  async function loadMessages(id){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');await loadProfile(d.call?.from_number||'');document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}";
  const newLoadMessages = "  async function loadMessages(id,{refreshProfile=true}={}){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');const nextPhone=d.call?.from_number||'';if(refreshProfile||selectedPhone!==nextPhone)await loadProfile(nextPhone);document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}";
  s = replaceOnce(s, oldLoadMessages, newLoadMessages, 'poll-safe message refresh');

  s = replaceOnce(
    s,
    "setInterval(async()=>{try{await refreshCalls();if(selected)await loadMessages(selected)}catch{}},3000)",
    "setInterval(async()=>{try{await refreshCalls();if(selected)await loadMessages(selected,{refreshProfile:false})}catch{}},3000)",
    'poll leaves dirty profile untouched',
  );

  s = replaceOnce(
    s,
    "document.getElementById('profileSaveBtn').onclick=()=>saveProfile();if(adminToken)start();",
    "document.getElementById('profileSaveBtn').onclick=()=>saveProfile();for(const id of ['profileName','profilePersonalization','profileMemory','profileEnabled']){const el=document.getElementById(id);el.addEventListener(id==='profileEnabled'?'change':'input',()=>{profileDirty=true;document.getElementById('profileStatus').textContent='未保存の変更あり'})}if(adminToken)start();",
    'mark phone history profile inputs dirty',
  );

  s = replaceOnce(
    s,
    "        queueLatency(turnId,'answer_ready',answerReadyAt-speechEndAt,{stageMs:answerReadyAt-turnStartedAt,route:clean(turn?.payload?.route||'',160),search:Boolean(turn?.payload?.search),searchRetried:Boolean(turn?.payload?.searchRetried),primaryMs:boundedMs(turn?.payload?.timings?.primaryMs),searchRetryMs:boundedMs(turn?.payload?.timings?.searchRetryMs),totalMs:boundedMs(turn?.payload?.timings?.totalMs)});",
    "        queueLatency(turnId,'answer_ready',answerReadyAt-speechEndAt,{stageMs:answerReadyAt-turnStartedAt,route:clean(turn?.payload?.route||'',160),search:Boolean(turn?.payload?.search),searchRetried:Boolean(turn?.payload?.searchRetried),primaryMs:boundedMs(turn?.payload?.timings?.primaryMs),searchRetryMs:boundedMs(turn?.payload?.timings?.searchRetryMs),totalMs:boundedMs(turn?.payload?.timings?.totalMs),groundingRequired:Boolean(turn?.payload?.groundingRequired),groundingEvidencePassed:Boolean(turn?.payload?.groundingEvidencePassed),groundingEvidenceReasons:Array.isArray(turn?.payload?.groundingEvidenceReasons)?turn.payload.groundingEvidenceReasons.slice(0,8):[],groundingSourceCount:Number(turn?.payload?.groundingSourceCount||0),groundingCitationCount:Number(turn?.payload?.groundingCitationCount||0),groundingCitationSpanCount:Number(turn?.payload?.groundingCitationSpanCount||0),groundingFailClosed:Boolean(turn?.payload?.groundingFailClosed),groundingRecoveryUsed:Boolean(turn?.payload?.groundingRecoveryUsed)});",
    'phone answer-ready grounding diagnostics',
  );

  s = replaceOnce(
    s,
    "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)",
    "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+\\/calls$/.test(pathname)",
    'caller history telephony path',
  );

  s = replaceOnce(
    s,
    "  const profileMatch=url.pathname.match(/^\\/phone\\/api\\/profiles\\/([^/]+)$/);if(profileMatch&&(request.method==='GET'||request.method==='PUT')){",
    "  const profileCallsMatch=url.pathname.match(/^\\/phone\\/api\\/profiles\\/([^/]+)\\/calls$/);if(request.method==='GET'&&profileCallsMatch){let phone;try{phone=decodeURIComponent(profileCallsMatch[1]);}catch{return json({ok:false,error:'invalid_phone_number'},400)}return profileCalls(request,env,phone);}\n  const profileMatch=url.pathname.match(/^\\/phone\\/api\\/profiles\\/([^/]+)$/);if(profileMatch&&(request.method==='GET'||request.method==='PUT')){",
    'caller history route handler',
  );

  return s;
});

write('tests/phone-quality-personalization-v120.test.mjs', (source) => {
  let s = source;
  s = s.replace("assert.equal(PHONE_PERSONALIZATION_ACTIVE_REVISION, 'talksys-phone-personalization-v120-r1');", "assert.equal(PHONE_PERSONALIZATION_ACTIVE_REVISION, 'talksys-phone-personalization-v121-r1');");
  s = s.replace("assert.equal(PHONE_RELEASE_VERSION, 'v120');", "assert.equal(PHONE_RELEASE_VERSION, 'v121');");
  s = s.replace("assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v120-r1');", "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v121-r1');");
  return s;
});

console.log('v121 guarded patch applied');
