from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one guarded match, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Keep legacy V129 profile users out of first-run onboarding, while retaining
# onboarding_version re-confirmation for users who already have V130 state.
replace_once(
    'src/v130-onboarding.js',
    """  const target = v130OnboardingVersion(env);\n  const profile = await profileSummary(db, phone);\n  return !(profile?.onboarding_completed_at && Number(profile?.onboarding_version || 0) >= target);\n""",
    """  const target = v130OnboardingVersion(env);\n  const profile = await profileSummary(db, phone);\n  const state = await readState(db, phone);\n  // A profile that predates V130 has no onboarding state. Preserve that user as-is\n  // instead of forcing a first-run flow onto an already personalized caller.\n  if (profile && !state && !profile?.onboarding_completed_at) return false;\n  return !(profile?.onboarding_completed_at && Number(profile?.onboarding_version || 0) >= target);\n""",
)

replace_once(
    'src/v130-onboarding.js',
    """  const existing = await readState(db, phone);\n  const profile = await profileSummary(db, phone);\n\n  if (!existing) {\n""",
    """  const existing = await readState(db, phone);\n  const profile = await profileSummary(db, phone);\n  const created = !existing;\n  const reset = Boolean(existing && Number(existing.onboarding_version || 0) < target);\n\n  if (created) {\n""",
)
replace_once(
    'src/v130-onboarding.js',
    """  } else if (Number(existing.onboarding_version || 0) < target) {\n""",
    """  } else if (reset) {\n""",
)
replace_once(
    'src/v130-onboarding.js',
    """  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };\n}\n\nexport async function saveV130Terms""",
    """  return { ok: true, created, reset, state: await readState(db, phone), profile: await profileSummary(db, phone) };\n}\n\nexport async function saveV130Terms""",
)
replace_once(
    'src/v130-onboarding.js',
    "export const V130_ONBOARDING_REVISION = 'talksys-v130-onboarding-r1';",
    "export const V130_ONBOARDING_REVISION = 'talksys-v130-onboarding-r2';",
)

# 2) Deterministic telephone onboarding state machine. No model extraction is used
# for terms, memory permission, or display name persistence.
Path('src/v130-phone-onboarding.js').write_text(r'''import {
  beginV130Onboarding,
  completeV130Onboarding,
  saveV130DisplayName,
  saveV130MemoryPreference,
  saveV130Terms,
  shouldRunV130Onboarding,
} from './v130-onboarding.js';

export const V130_PHONE_ONBOARDING_REVISION = 'talksys-v130d-phone-onboarding-r1';

function clean(value, max = 1800) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

export const V130_ONBOARDING_TEXT = Object.freeze({
  intro: 'はじめまして、TalkSysです。最初の一度だけ利用設定を確認します。緊急通報や、生命・身体に関わる緊急対応には利用できません。また、回答を誤ることがありますので、重要な判断では公的機関や専門家の情報も確認してください。続いて、利用規約とプライバシー方針への同意を確認します。同意する場合は「同意します」、同意しない場合は「同意しません」とお答えください。最初にお話しいただいたご用件は、設定が終わったあとにもう一度お願いします。',
  termsRetry: '利用規約とプライバシー方針への同意を確認します。「同意します」または「同意しません」とお答えください。',
  termsRejected: '通常の相談を始めるには、利用規約とプライバシー方針への同意が必要です。同意される場合は「同意します」とお答えください。',
  memory: 'ありがとうございます。次に、今後の会話を話しやすくするため、呼び名や好みなどを電話番号ごとに記憶してよいですか。「記憶してよい」または「記憶しない」とお答えください。',
  memoryRetry: '会話内容から呼び名や好みなどを記憶してよいか確認します。「記憶してよい」または「記憶しない」とお答えください。',
  name: '最後に、何とお呼びすればよいですか。呼んでほしい名前だけをお答えください。',
  nameRetry: '呼んでほしい名前を短くお答えください。たとえば「山田です」のようにお答えいただけます。',
  complete: '設定は完了しました。ありがとうございます。ご用件をどうぞ。',
  unavailable: '初回設定を保存できませんでした。お手数ですが、少し時間をおいてからもう一度おかけ直しください。',
});

export function classifyV130OnboardingAnswer(text = '') {
  const value = clean(text, 120).normalize('NFKC').replace(/[。．.!！?？、,\s]+$/g, '').trim();
  if (!value) return 'unknown';
  if (/^(?:いいえ|いや|嫌です|だめ|ダメ|拒否(?:します)?|同意しません|同意しない|承諾しません|承諾しない|記憶しない|記憶しないで|覚えないで|保存しない|不要(?:です)?|オフ(?:にして)?|やめ(?:て|ます)?|しません)$/u.test(value)) return 'no';
  if (/^(?:はい|ええ|うん|お願いします|いいです|大丈夫です|同意します|同意する|承諾します|承諾する|記憶してよい|記憶していい|記憶して|覚えて|保存して|オン(?:にして)?|します)$/u.test(value)) return 'yes';
  return 'unknown';
}

export function normalizeV130DisplayName(text = '') {
  let value = clean(text, 100).normalize('NFKC')
    .replace(/^[「『\"']+|[」』\"']+$/g, '')
    .replace(/^(?:私(?:の名前)?は|名前は|呼び名は|ニックネームは)\s*/u, '')
    .replace(/\s*(?:と呼んでください|と呼んで下さい|と呼んで|でお願いします|と申します|です|といいます|と言います)[。．.!！]*$/u, '')
    .trim();
  if (!value || value.length > 40) return '';
  if (classifyV130OnboardingAnswer(value) !== 'unknown') return '';
  if (!/[\p{L}\p{N}]/u.test(value)) return '';
  if (/[\r\n\t]/u.test(value)) return '';
  return value;
}

function response(reply, stage, extra = {}) {
  return { handled: true, reply, stage, revision: V130_PHONE_ONBOARDING_REVISION, ...extra };
}

export async function handleV130PhoneOnboardingTurn(env, phoneNumber, text) {
  const utterance = clean(text, 1800);
  if (!utterance) return { handled: false, reason: 'empty_utterance', revision: V130_PHONE_ONBOARDING_REVISION };
  if (!(await shouldRunV130Onboarding(env, phoneNumber))) {
    return { handled: false, reason: 'not_required', revision: V130_PHONE_ONBOARDING_REVISION };
  }

  const started = await beginV130Onboarding(env, phoneNumber);
  if (!started?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: started?.error || 'onboarding_start_failed' });
  if (started.created || started.reset) return response(V130_ONBOARDING_TEXT.intro, 'intro', { state: started.state });

  const step = String(started?.state?.current_step || 'terms');
  if (step === 'terms') {
    const answer = classifyV130OnboardingAnswer(utterance);
    if (answer === 'unknown') return response(V130_ONBOARDING_TEXT.termsRetry, 'terms', { state: started.state });
    const saved = await saveV130Terms(env, phoneNumber, answer === 'yes');
    if (!saved?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: saved?.error || 'terms_save_failed' });
    if (answer === 'no') return response(V130_ONBOARDING_TEXT.termsRejected, 'terms', { state: saved.state });
    return response(V130_ONBOARDING_TEXT.memory, 'memory', { state: saved.state });
  }

  if (step === 'memory') {
    const answer = classifyV130OnboardingAnswer(utterance);
    if (answer === 'unknown') return response(V130_ONBOARDING_TEXT.memoryRetry, 'memory', { state: started.state });
    const saved = await saveV130MemoryPreference(env, phoneNumber, answer === 'yes');
    if (!saved?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: saved?.error || 'memory_save_failed' });
    if (saved?.state?.current_step === 'complete') {
      const completed = await completeV130Onboarding(env, phoneNumber);
      if (!completed?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: completed?.error || 'onboarding_complete_failed' });
      return response(V130_ONBOARDING_TEXT.complete, 'complete', { completed: true, state: completed.state });
    }
    return response(V130_ONBOARDING_TEXT.name, 'name', { state: saved.state });
  }

  if (step === 'name') {
    const name = normalizeV130DisplayName(utterance);
    if (!name) return response(V130_ONBOARDING_TEXT.nameRetry, 'name', { state: started.state });
    const saved = await saveV130DisplayName(env, phoneNumber, name);
    if (!saved?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: saved?.error || 'display_name_save_failed' });
    const completed = await completeV130Onboarding(env, phoneNumber);
    if (!completed?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: completed?.error || 'onboarding_complete_failed' });
    return response(V130_ONBOARDING_TEXT.complete, 'complete', { completed: true, displayName: name, state: completed.state });
  }

  if (step === 'complete') {
    const completed = await completeV130Onboarding(env, phoneNumber);
    if (!completed?.ok) return response(V130_ONBOARDING_TEXT.unavailable, 'error', { error: completed?.error || 'onboarding_complete_failed' });
    return response(V130_ONBOARDING_TEXT.complete, 'complete', { completed: true, state: completed.state });
  }

  return response(V130_ONBOARDING_TEXT.termsRetry, 'terms', { state: started.state });
}
''', encoding='utf-8')

# 3) Only expose the callback to telephony when the WebSocket handshake has an
# active onboarding mode. Flag OFF therefore stays on the unchanged normal path.
replace_once(
    'src/integrated-entry.js',
    "import { GROUNDING_EVIDENCE_REVISION, groundingEvidenceReport } from './grounding-evidence-gate.js';\n",
    "import { GROUNDING_EVIDENCE_REVISION, groundingEvidenceReport } from './grounding-evidence-gate.js';\nimport { handleV130PhoneOnboardingTurn } from './v130-phone-onboarding.js';\n",
)
replace_once(
    'src/integrated-entry.js',
    """    const telephonyResponse = await handleTelephonyRequest(request, env, ctx, {\n      turn: (body, signal) => runTalkSysTurn(request, env, body, signal || request.signal, ctx),\n    });\n""",
    """    const telephonyResponse = await handleTelephonyRequest(request, env, ctx, {\n      turn: (body, signal) => runTalkSysTurn(request, env, body, signal || request.signal, ctx),\n      ...(env?.V130_ONBOARDING_RUNTIME_MODE ? {\n        onboardingTurn: (phoneNumber, text) => handleV130PhoneOnboardingTurn(env, phoneNumber, text),\n      } : {}),\n    });\n""",
)

# 4) Mark only the media-session env after reading the fail-closed feature flag.
replace_once(
    'src/runtime-entry.js',
    "export const RUNTIME_ENTRY_REVISION = 'talksys-runtime-entry-v130-memory-jobs-r2';",
    "export const RUNTIME_ENTRY_REVISION = 'talksys-runtime-entry-v130d-onboarding-r1';",
)
replace_once(
    'src/runtime-entry.js',
    """    let delegatedEnv = env;\n    if (url.pathname === '/telnyx/media') {\n      const memoryMode = await readV130Flag(env, 'memory_jobs');\n      if (memoryMode === 'shadow' || memoryMode === 'active') delegatedEnv = withV130MemoryQueueObserver(env);\n    }\n    return integratedEntry.fetch(request, delegatedEnv, ctx);\n""",
    """    let delegatedEnv = env;\n    if (url.pathname === '/telnyx/media') {\n      const [memoryMode, onboardingMode] = await Promise.all([\n        readV130Flag(env, 'memory_jobs'),\n        readV130Flag(env, 'onboarding'),\n      ]);\n      if (memoryMode === 'shadow' || memoryMode === 'active') delegatedEnv = withV130MemoryQueueObserver(env);\n      if (onboardingMode === 'allowlist' || onboardingMode === 'all') {\n        const sessionEnv = Object.create(delegatedEnv);\n        Object.defineProperty(sessionEnv, 'V130_ONBOARDING_RUNTIME_MODE', { value: onboardingMode, enumerable: true });\n        delegatedEnv = sessionEnv;\n      }\n    }\n    return integratedEntry.fetch(request, delegatedEnv, ctx);\n""",
)

# 5) Insert one deterministic control-flow hook after successful STT acceptance and
# before fast reaction / model work. VAD, STT, TTS synthesis, PCMU pacing and
# interruption mechanics are intentionally untouched.
replace_once(
    'src/telephony/index.js',
    """      try{\n        const reaction=fastReaction(stt.text);\n""",
    """      try{\n        if(typeof deps?.onboardingTurn==='function'){\n          let onboarding=null;\n          try{onboarding=await deps.onboardingTurn(from,stt.text);}\n          catch(error){console.error(JSON.stringify({type:'phone_onboarding_error',turnId,error:clean(error?.message||error,240)}));onboarding={handled:true,reply:'初回設定を保存できませんでした。お手数ですが、少し時間をおいてからもう一度おかけ直しください。',stage:'error'};}\n          if(onboarding?.handled){\n            const onboardingReply=clean(onboarding?.reply||'',9000);\n            queueLatency(turnId,'onboarding_handled',Date.now()-speechEndAt,{stage:clean(onboarding?.stage||'',80),revision:clean(onboarding?.revision||'',120),completed:Boolean(onboarding?.completed)});\n            if(onboardingReply){history.push({role:'assistant',content:onboardingReply});queueMessageLog('assistant',onboardingReply);if(myVersion===turnVersion){const spoken=await speak(onboardingReply,{purpose:'onboarding',turnId,originAt:speechEndAt});if(!spoken&&!closed&&myVersion===turnVersion)await setCallStatus(env,callId,'tts-error');}}\n            return;\n          }\n        }\n        const reaction=fastReaction(stt.text);\n""",
)

# 6) Functional in-memory D1 tests for initial flow, interrupted resume, second-call
# suppression, legacy profile exemption, flag OFF and onboarding_version re-check.
Path('tests/v130-phone-onboarding.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  V130_ONBOARDING_TEXT,
  classifyV130OnboardingAnswer,
  handleV130PhoneOnboardingTurn,
  normalizeV130DisplayName,
} from '../src/v130-phone-onboarding.js';

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first() {
    const q = this.sql.toLowerCase();
    if (q.startsWith('select value from talksys_feature_flags')) return { value: this.db.flags.get(this.args[0]) || 'off' };
    if (q.includes('from phone_user_trash')) return this.db.trash.has(this.args[0]) ? { phone_number: this.args[0] } : null;
    if (q.includes('from phone_onboarding_allowlist')) return this.db.allowlist.has(this.args[0]) ? { phone_number: this.args[0] } : null;
    if (q.includes('from phone_onboarding_state')) return this.db.states.get(this.args[0]) || null;
    if (q.includes('from phone_profiles')) return this.db.profiles.get(this.args[0]) || null;
    throw new Error(`unhandled first SQL: ${this.sql}`);
  }
  async run() {
    const q = this.sql.toLowerCase();
    const a = this.args;
    if (q.startsWith('insert or ignore into phone_profiles')) {
      if (!this.db.profiles.has(a[0])) this.db.profiles.set(a[0], {
        phone_number: a[0], display_name: a[1], personalization_text: a[2], memory_text: a[3], enabled: 1,
        version: 1, created_at: a[4], updated_at: a[5], lifecycle_state: 'active', memory_enabled: 1,
        onboarding_version: 0, terms_accepted_at: null, onboarding_completed_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('insert into phone_onboarding_state')) {
      this.db.states.set(a[0], { phone_number: a[0], current_step: a[1], terms_status: a[2], memory_status: a[3], name_status: a[4], onboarding_version: a[5], started_at: a[6], updated_at: a[7], completed_at: null });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("update phone_onboarding_state set current_step='terms'")) {
      Object.assign(this.db.states.get(a[4]), { current_step: 'terms', terms_status: 'pending', memory_status: 'pending', name_status: a[0], onboarding_version: a[1], started_at: a[2], updated_at: a[3], completed_at: null });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_onboarding_state set terms_status=?')) {
      Object.assign(this.db.states.get(a[4]), { terms_status: a[0], current_step: a[1], onboarding_version: a[2], updated_at: a[3] });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_profiles set terms_accepted_at=?')) {
      const p = this.db.profiles.get(a[3]); Object.assign(p, { terms_accepted_at: a[0], onboarding_version: a[1], updated_at: a[2], version: p.version + 1 }); return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_onboarding_state set memory_status=?')) {
      Object.assign(this.db.states.get(a[3]), { memory_status: a[0], current_step: a[1], updated_at: a[2] }); return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_profiles set memory_enabled=?')) {
      const p = this.db.profiles.get(a[2]); Object.assign(p, { memory_enabled: a[0], updated_at: a[1], version: p.version + 1 }); return { meta: { changes: 1 } };
    }
    if (q.startsWith("update phone_onboarding_state set name_status='saved'")) {
      Object.assign(this.db.states.get(a[2]), { name_status: 'saved', current_step: a[0], updated_at: a[1] }); return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_profiles set display_name=?')) {
      const p = this.db.profiles.get(a[2]); Object.assign(p, { display_name: a[0], updated_at: a[1], version: p.version + 1 }); return { meta: { changes: 1 } };
    }
    if (q.startsWith("update phone_onboarding_state set current_step='complete'")) {
      Object.assign(this.db.states.get(a[2]), { current_step: 'complete', completed_at: a[0], updated_at: a[1] }); return { meta: { changes: 1 } };
    }
    if (q.startsWith('update phone_profiles set onboarding_completed_at=?')) {
      const p = this.db.profiles.get(a[3]); Object.assign(p, { onboarding_completed_at: a[0], onboarding_version: a[1], updated_at: a[2], version: p.version + 1 }); return { meta: { changes: 1 } };
    }
    throw new Error(`unhandled run SQL: ${this.sql}`);
  }
}

class MemoryD1 {
  constructor(mode = 'all') { this.flags = new Map([['onboarding', mode]]); this.profiles = new Map(); this.states = new Map(); this.trash = new Set(); this.allowlist = new Set(); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; }
}

function env(db, version = 1) { return { TALKSYS_LOG_DB: db, PHONE_ONBOARDING_VERSION: String(version) }; }

test('V130d parser is deterministic for consent/memory and does not infer arbitrary text', () => {
  assert.equal(classifyV130OnboardingAnswer('同意します'), 'yes');
  assert.equal(classifyV130OnboardingAnswer('記憶しない'), 'no');
  assert.equal(classifyV130OnboardingAnswer('明日の天気を教えて'), 'unknown');
  assert.equal(normalizeV130DisplayName('名前は 山田 と呼んでください'), '山田');
  assert.equal(normalizeV130DisplayName('はい'), '');
});

test('V130d completes first valid-user onboarding and suppresses it on the second call', async () => {
  const db = new MemoryD1('all'); const e = env(db, 1); const phone = '+819012345678';
  const intro = await handleV130PhoneOnboardingTurn(e, phone, '明日の天気を教えて');
  assert.equal(intro.handled, true); assert.equal(intro.stage, 'intro'); assert.equal(intro.reply, V130_ONBOARDING_TEXT.intro);
  assert.equal(db.states.get(phone).current_step, 'terms');
  const terms = await handleV130PhoneOnboardingTurn(e, phone, '同意します');
  assert.equal(terms.stage, 'memory'); assert.ok(db.profiles.get(phone).terms_accepted_at);
  const memory = await handleV130PhoneOnboardingTurn(e, phone, '記憶しない');
  assert.equal(memory.stage, 'name'); assert.equal(db.profiles.get(phone).memory_enabled, 0);
  const named = await handleV130PhoneOnboardingTurn(e, phone, '山田と呼んでください');
  assert.equal(named.stage, 'complete'); assert.equal(named.completed, true); assert.equal(db.profiles.get(phone).display_name, '山田');
  assert.ok(db.profiles.get(phone).onboarding_completed_at);
  const second = await handleV130PhoneOnboardingTurn(e, phone, '別府の天気は');
  assert.equal(second.handled, false); assert.equal(second.reason, 'not_required');
});

test('V130d resumes an interrupted onboarding from the persisted missing step', async () => {
  const db = new MemoryD1('all'); const e = env(db, 1); const phone = '+819011111111';
  await handleV130PhoneOnboardingTurn(e, phone, '相談があります');
  assert.equal(db.states.get(phone).current_step, 'terms');
  const resumed = await handleV130PhoneOnboardingTurn(e, phone, 'はい');
  assert.equal(resumed.stage, 'memory'); assert.equal(db.states.get(phone).terms_status, 'accepted');
});

test('V130d leaves existing V129 profile users and tombstoned users untouched', async () => {
  const db = new MemoryD1('all'); const phone = '+819022222222';
  db.profiles.set(phone, { phone_number: phone, display_name: '既存利用者', personalization_text: '丁寧に', memory_text: '既存メモ', enabled: 1, version: 8, lifecycle_state: 'active', memory_enabled: 1, onboarding_version: 0, terms_accepted_at: null, onboarding_completed_at: null });
  const legacy = await handleV130PhoneOnboardingTurn(env(db, 1), phone, 'こんにちは');
  assert.equal(legacy.handled, false); assert.equal(db.states.has(phone), false); assert.equal(db.profiles.get(phone).display_name, '既存利用者');
  const tomb = '+819033333333'; db.trash.add(tomb);
  const trashed = await handleV130PhoneOnboardingTurn(env(db, 1), tomb, 'こんにちは');
  assert.equal(trashed.handled, false); assert.equal(db.states.has(tomb), false);
});

test('V130d flag OFF has no onboarding state mutation', async () => {
  const db = new MemoryD1('off'); const phone = '+819044444444';
  const result = await handleV130PhoneOnboardingTurn(env(db, 1), phone, 'こんにちは');
  assert.equal(result.handled, false); assert.equal(db.profiles.has(phone), false); assert.equal(db.states.has(phone), false);
});

test('V130d onboarding_version bump re-confirms terms/memory but keeps an existing display name', async () => {
  const db = new MemoryD1('all'); const phone = '+819055555555'; const e1 = env(db, 1);
  await handleV130PhoneOnboardingTurn(e1, phone, '相談');
  await handleV130PhoneOnboardingTurn(e1, phone, '同意します');
  await handleV130PhoneOnboardingTurn(e1, phone, '記憶してよい');
  await handleV130PhoneOnboardingTurn(e1, phone, '佐藤です');
  const v2intro = await handleV130PhoneOnboardingTurn(env(db, 2), phone, '相談');
  assert.equal(v2intro.stage, 'intro'); assert.equal(db.states.get(phone).onboarding_version, 2); assert.equal(db.states.get(phone).name_status, 'saved');
  const v2terms = await handleV130PhoneOnboardingTurn(env(db, 2), phone, '同意します');
  assert.equal(v2terms.stage, 'memory');
  const v2memory = await handleV130PhoneOnboardingTurn(env(db, 2), phone, '記憶してよい');
  assert.equal(v2memory.stage, 'complete'); assert.equal(v2memory.completed, true); assert.equal(db.profiles.get(phone).display_name, '佐藤');
});

test('V130d hook sits after accepted STT and before normal reaction/model path', async () => {
  const telephony = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  const integrated = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../src/runtime-entry.js', import.meta.url), 'utf8');
  const userAccepted = telephony.indexOf("queueMessageLog('user', stt.text)");
  const hook = telephony.indexOf('deps.onboardingTurn(from,stt.text)');
  const normalReaction = telephony.indexOf('const reaction=fastReaction(stt.text)', hook);
  assert.ok(userAccepted >= 0 && hook > userAccepted && normalReaction > hook);
  assert.match(integrated, /V130_ONBOARDING_RUNTIME_MODE[\s\S]*onboardingTurn/);
  assert.match(runtime, /Promise\.all\([\s\S]*readV130Flag\(env, 'memory_jobs'\)[\s\S]*readV130Flag\(env, 'onboarding'\)/);
  assert.match(runtime, /onboardingMode === 'allowlist' \|\| onboardingMode === 'all'/);
});
''', encoding='utf-8')

print('V130d onboarding patch applied')
