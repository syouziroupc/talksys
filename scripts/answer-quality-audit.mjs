import fs from 'node:fs';

const PRODUCTION_URL = String(process.env.PRODUCTION_URL || 'https://talksys.syouziroupc.workers.dev').replace(/\/$/, '');
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const AUDIT_MODEL = String(process.env.AUDIT_MODEL || 'gemini-3.5-flash-lite').trim();
const CASE_FILTER = String(process.env.CASE_FILTER || '').trim();
const AUDIT_QUESTION = String(process.env.AUDIT_QUESTION || '').trim();
const CASE_FILE = process.env.CASE_FILE || 'qa/answer-quality-cases.json';
const OUT_DIR = process.env.AUDIT_OUT_DIR || 'artifacts/answer-quality-audit';
const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    factual_errors: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    material_omissions: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    corrected_answer: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'factual_errors', 'material_omissions', 'corrected_answer', 'rationale'],
  additionalProperties: false,
};

function compact(value, max = 1200) {
  return String(value ?? '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function markdownCell(value, max = 220) {
  return compact(value, max).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function outputText(payload = {}) {
  const parts = [];
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type === 'text' && typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return compact(parts.join(''), 20000);
}

function judgeEvidence(payload = {}) {
  const queries = [];
  const citations = [];
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type === 'google_search_call') {
      for (const query of Array.isArray(step?.arguments?.queries) ? step.arguments.queries : []) {
        const q = compact(query, 300);
        if (q && !queries.includes(q)) queries.push(q);
      }
    }
    if (step?.type === 'google_search_result') {
      for (const item of Array.isArray(step?.result) ? step.result : []) {
        const url = compact(item?.url || item?.uri, 1000);
        if (!/^https?:\/\//i.test(url) || citations.some((entry) => entry.url === url)) continue;
        citations.push({
          title: compact(item?.title || item?.name || url, 240),
          url,
          startIndex: -1,
          endIndex: -1,
          source: 'google_search_result',
        });
      }
    }
    if (step?.type === 'model_output') {
      for (const part of Array.isArray(step?.content) ? step.content : []) {
        if (part?.type !== 'text') continue;
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type !== 'url_citation') continue;
          const url = compact(annotation?.url, 1000);
          if (!url || citations.some((item) => item.url === url)) continue;
          citations.push({
            title: compact(annotation?.title || url, 240),
            url,
            startIndex: Number(annotation?.start_index ?? -1),
            endIndex: Number(annotation?.end_index ?? -1),
            source: 'url_citation',
          });
        }
      }
    }
  }
  return { searched: queries.length > 0, queries, citations };
}

async function fetchJson(url, options = {}, timeoutMs = 120000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`invalid_json:${response.status}:${compact(raw, 500)}`); }
  if (!response.ok) throw new Error(`http_${response.status}:${compact(body?.error || body?.detail || raw, 700)}`);
  return body;
}

async function productionHealth() {
  return fetchJson(`${PRODUCTION_URL}/gemini-health`, {}, 30000);
}

async function askProduction(testCase) {
  const started = Date.now();
  const payload = await fetchJson(`${PRODUCTION_URL}/api/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: testCase.prompt,
      history: Array.isArray(testCase.history) ? testCase.history : [],
      channel: 'web',
    }),
  });
  return { payload, elapsedMs: Date.now() - started };
}

async function judgeAnswer(testCase, productionPayload) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for independent answer judging');
  const referenceTime = compact(productionPayload?.authoritativeJst || new Date().toISOString(), 80);
  const productionSources = Array.isArray(productionPayload?.sources) ? productionPayload.sources : [];
  const input = [
    '次の回答の事実正確性を独立監査してください。元回答を信用せず、Google検索で一次情報・公式情報を優先して再確認してください。',
    '現在・今日・次の便などの相対時刻は、下記の回答基準時刻に固定して判定してください。監査実行時刻へ勝手にずらさないでください。',
    '事実誤りが1つでもあれば verdict=fail。必要な事実を検索しても確定できない場合は verdict=uncertain。事実誤りがなく質問に十分答えている場合だけ verdict=pass。',
    '細かな文体や簡潔さは採点対象外です。数値、日付、時刻、価格、住所、営業時間、人名、役職、法令、製品仕様、運行情報などの具体値を特に厳しく確認してください。',
    `回答基準時刻: ${referenceTime}`,
    `カテゴリ: ${testCase.category || 'adhoc'}`,
    `元の質問: ${testCase.prompt}`,
    `TalkSys回答: ${compact(productionPayload?.answer, 12000)}`,
    `TalkSysが返した検索元メタデータ: ${JSON.stringify(productionSources).slice(0, 8000)}`,
    'corrected_answer は fail/uncertain の場合に、検索で確認できた範囲の正しい短い回答を書いてください。pass の場合は空文字で構いません。',
  ].join('\n');

  const requestBody = {
    model: AUDIT_MODEL,
    input,
    system_instruction: 'あなたはTalkSysの外部品質監査器です。回答生成系とは独立した新規セッションとして、検索根拠に基づく事実検証だけを行ってください。',
    tools: [{ type: 'google_search' }],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: JUDGE_SCHEMA,
    },
  };

  const started = Date.now();
  const payload = await fetchJson(INTERACTIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(requestBody),
  });
  const text = outputText(payload);
  if (!text) throw new Error('empty_judge_output');
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error(`invalid_judge_json:${compact(text, 700)}`); }
  return {
    result,
    evidence: judgeEvidence(payload),
    elapsedMs: Date.now() - started,
  };
}

function structuralChecks(testCase, productionPayload) {
  const checks = [];
  const answer = String(productionPayload?.answer || '');
  checks.push({ name: 'production_ok', pass: productionPayload?.ok === true, detail: compact(productionPayload?.error || productionPayload?.detail || '') });
  checks.push({ name: 'answer_nonempty', pass: answer.trim().length > 0, detail: '' });

  if (testCase.requireSearch === true) {
    checks.push({ name: 'search_executed', pass: productionPayload?.search === true, detail: `search=${String(productionPayload?.search)}` });
  }
  if (Number.isFinite(Number(testCase.minSources))) {
    const count = Array.isArray(productionPayload?.sources) ? productionPayload.sources.length : Number(productionPayload?.groundingSourceCount || 0);
    checks.push({ name: 'source_count', pass: count >= Number(testCase.minSources), detail: `sources=${count}` });
  }
  if (Number.isFinite(Number(testCase.minCitations))) {
    const count = Number(productionPayload?.groundingCitationCount || 0);
    checks.push({ name: 'citation_count', pass: count >= Number(testCase.minCitations), detail: `citations=${count}` });
  }
  if (productionPayload?.groundingFailClosed === true) {
    checks.push({ name: 'grounding_not_failed', pass: false, detail: 'groundingFailClosed=true' });
  }
  for (const required of Array.isArray(testCase.mustInclude) ? testCase.mustInclude : []) {
    checks.push({ name: `must_include:${required}`, pass: answer.includes(required), detail: '' });
  }
  for (const forbidden of Array.isArray(testCase.mustNotInclude) ? testCase.mustNotInclude : []) {
    checks.push({ name: `must_not_include:${forbidden}`, pass: !answer.includes(forbidden), detail: '' });
  }
  return checks;
}

function loadCases() {
  if (AUDIT_QUESTION) {
    return [{ id: 'adhoc', category: 'adhoc', prompt: AUDIT_QUESTION, judge: true }];
  }
  const parsed = JSON.parse(fs.readFileSync(CASE_FILE, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('audit_cases_empty');
  if (!CASE_FILTER) return parsed;
  const wanted = new Set(CASE_FILTER.split(',').map((value) => value.trim()).filter(Boolean));
  return parsed.filter((testCase) => wanted.has(testCase.id) || wanted.has(testCase.category));
}

function writeReports(report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push('# TalkSys direct answer quality audit');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Production: ${report.productionUrl}`);
  lines.push(`- Production model: ${report.productionModel}`);
  lines.push(`- Audit model: ${report.auditModel}`);
  lines.push(`- Cases: ${report.total} / pass ${report.passed} / fail ${report.failed}`);
  lines.push('');
  lines.push('| Result | Case | Category | Production answer | Structural | Judge |');
  lines.push('|---|---|---|---|---|---|');
  for (const item of report.cases) {
    const structuralFailures = item.structuralChecks.filter((check) => !check.pass).map((check) => check.name).join(', ') || 'OK';
    const judgeSummary = item.judge
      ? `${item.judge.result?.verdict || 'error'} (${Number(item.judge.result?.confidence || 0).toFixed(2)})${item.judge.evidence?.searched && !item.judge.evidence?.citations?.length ? ' / citation-metadata-warning' : ''}`
      : 'not required';
    lines.push(`| ${item.pass ? 'PASS' : 'FAIL'} | ${markdownCell(item.id, 80)} | ${markdownCell(item.category, 80)} | ${markdownCell(item.production?.answer, 180)} | ${markdownCell(structuralFailures, 140)} | ${markdownCell(judgeSummary, 140)} |`);
  }

  for (const item of report.cases) {
    lines.push('');
    lines.push(`## ${item.pass ? 'PASS' : 'FAIL'} — ${item.id}`);
    lines.push('');
    lines.push(`**Question:** ${item.prompt}`);
    lines.push('');
    lines.push(`**Production answer:** ${item.production?.answer || '(empty)'}`);
    lines.push('');
    lines.push(`**Production route:** ${item.production?.route || ''}`);
    lines.push('');
    lines.push(`**Production search:** ${String(item.production?.search)} / sources ${Array.isArray(item.production?.sources) ? item.production.sources.length : 0} / citations ${Number(item.production?.groundingCitationCount || 0)}`);
    if (Array.isArray(item.production?.sources) && item.production.sources.length) {
      lines.push('');
      lines.push('**Production sources:**');
      for (const source of item.production.sources) lines.push(`- ${source.title || source.url} — ${source.url}`);
    }
    if (item.judge) {
      lines.push('');
      lines.push(`**Judge verdict:** ${item.judge.result?.verdict || 'error'} / confidence ${Number(item.judge.result?.confidence || 0).toFixed(2)}`);
      lines.push('');
      lines.push(`**Judge search executed:** ${String(item.judge.evidence?.searched === true)} / extracted source metadata ${item.judge.evidence?.citations?.length || 0}`);
      if (item.judge.evidence?.searched === true && !(item.judge.evidence?.citations?.length > 0)) {
        lines.push('');
        lines.push('**Judge evidence warning:** Google Search was executed, but this Interactions response did not expose extractable source/citation metadata. This is recorded as a warning and is not by itself treated as a production-answer failure.');
      }
      if (Array.isArray(item.judge.result?.factual_errors) && item.judge.result.factual_errors.length) {
        lines.push('');
        lines.push('**Factual errors:**');
        for (const issue of item.judge.result.factual_errors) lines.push(`- ${issue}`);
      }
      if (Array.isArray(item.judge.result?.material_omissions) && item.judge.result.material_omissions.length) {
        lines.push('');
        lines.push('**Material omissions:**');
        for (const issue of item.judge.result.material_omissions) lines.push(`- ${issue}`);
      }
      if (item.judge.result?.corrected_answer) {
        lines.push('');
        lines.push(`**Corrected answer:** ${item.judge.result.corrected_answer}`);
      }
      lines.push('');
      lines.push(`**Judge rationale:** ${item.judge.result?.rationale || ''}`);
      if (Array.isArray(item.judge.evidence?.citations) && item.judge.evidence.citations.length) {
        lines.push('');
        lines.push('**Independent judge sources:**');
        for (const source of item.judge.evidence.citations) lines.push(`- ${source.title || source.url} — ${source.url}`);
      }
    }
  }

  fs.writeFileSync(`${OUT_DIR}/report.md`, `${lines.join('\n')}\n`);
}

async function main() {
  const health = await productionHealth();
  const productionModel = compact(health?.model || '', 120);
  if (!productionModel) throw new Error('production_model_unknown');
  if (productionModel !== AUDIT_MODEL) {
    throw new Error(`audit_model_mismatch: production=${productionModel} audit=${AUDIT_MODEL}`);
  }

  const cases = loadCases();
  if (!cases.length) throw new Error(`no_cases_matched:${CASE_FILTER}`);
  const results = [];

  for (const testCase of cases) {
    const structuralChecksBefore = [];
    let production = {};
    let productionElapsedMs = 0;
    let judge = null;
    let error = '';
    try {
      const asked = await askProduction(testCase);
      production = asked.payload;
      productionElapsedMs = asked.elapsedMs;
      const checks = structuralChecks(testCase, production);
      structuralChecksBefore.push(...checks);

      if (testCase.judge !== false) {
        const judged = await judgeAnswer(testCase, production);
        judge = judged;
      }
    } catch (caught) {
      error = compact(caught?.message || caught, 1200);
    }

    const structuralPass = structuralChecksBefore.length > 0 && structuralChecksBefore.every((check) => check.pass);
    const judgeRequired = testCase.judge !== false;
    const judgePass = !judgeRequired || Boolean(
      judge
      && judge.evidence?.searched === true
      && judge.result?.verdict === 'pass'
      && Number(judge.result?.confidence || 0) >= 0.75
    );
    const pass = !error && structuralPass && judgePass;
    results.push({
      id: testCase.id,
      category: testCase.category || 'uncategorized',
      prompt: testCase.prompt,
      pass,
      error,
      structuralChecks: structuralChecksBefore,
      productionElapsedMs,
      production,
      judge,
    });
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${testCase.id} production=${productionElapsedMs}ms judge=${judge?.elapsedMs || 0}ms\n`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    productionUrl: PRODUCTION_URL,
    productionModel,
    auditModel: AUDIT_MODEL,
    total: results.length,
    passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length,
    cases: results,
  };
  writeReports(report);
  process.stdout.write(`RESULT total=${report.total} passed=${report.passed} failed=${report.failed}\n`);
}

main().catch((error) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fatal = { generatedAt: new Date().toISOString(), fatal: true, error: compact(error?.message || error, 2000) };
  fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(fatal, null, 2));
  fs.writeFileSync(`${OUT_DIR}/report.md`, `# TalkSys direct answer quality audit\n\nFATAL: ${fatal.error}\n`);
  console.error(error);
  process.exitCode = 1;
});
