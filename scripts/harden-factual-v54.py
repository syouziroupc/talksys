from pathlib import Path

# This migration runs after harden-jst-v53.py.  It broadens the same fail-closed
# policy from time/transit to named entities, recommendations, product facts and
# ordinary factual questions while keeping the Gemini model fixed.

entry_path = Path('src/entry.js')
entry = entry_path.read_text()


def entry_replace(old, new, label):
    global entry
    if old not in entry:
        raise SystemExit(f'missing entry patch anchor: {label}')
    entry = entry.replace(old, new, 1)


entry_replace(
    "export const RESPONSE_QUALITY_REVISION = 'talksys-v53-router-first-jst-r1';",
    "export const RESPONSE_QUALITY_REVISION = 'talksys-v54-evidence-first-r1';",
    'response quality revision',
)

entry_replace(
    "const DYNAMIC_FACT_RE = /(最新|現在|今日|明日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|営業時間|バージョン)/i;",
    "const DYNAMIC_FACT_RE = /(最新|現在|今日|明日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|営業時間|バージョン)/i;\nconst EVIDENCE_REQUIRED_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|商品|製品|型番|モデル|仕様|互換|対応|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在|価格|値段|相場|在庫|発売|最新|現在|今日|明日|ニュース|運行|時刻表|天気|為替|法律|制度|バージョン)/i;\nconst NAMED_ENTITY_RE = /(?:「([^」]{2,60})」|『([^』]{2,60})』|([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,48}(?:店|店舗|商店|工房|電器|電機|病院|医院|クリニック|ホテル|旅館|カフェ|喫茶店|レストラン|株式会社|合同会社|有限会社)))/g;",
    'evidence-required regexes',
)

entry_replace(
    "function removeUnauthorizedTransitRouteClaims(answer) {\n  const kept = sentences(answer).filter((sentence) => !EXACT_TRANSIT_RE.test(sentence));\n  return clean(kept.join(''), 12000);\n}\n",
    "function removeUnauthorizedTransitRouteClaims(answer) {\n  const kept = sentences(answer).filter((sentence) => !EXACT_TRANSIT_RE.test(sentence));\n  return clean(kept.join(''), 12000);\n}\n\nfunction evidenceCorpus(payload = {}, question = '') {\n  const sourceText = (Array.isArray(payload?.sources) ? payload.sources : []).map((source) => `${source?.title || ''} ${source?.url || ''}`).join(' ');\n  const apiText = (Array.isArray(payload?.apiSources) ? payload.apiSources : []).map((source) => `${source?.tool || ''} ${source?.category || ''} ${source?.attribution || ''} ${source?.sourceUrl || ''}`).join(' ');\n  return normalize(`${question} ${sourceText} ${apiText}`);\n}\n\nfunction namedEntitySupported(token, corpus) {\n  const normalized = normalize(token);\n  if (!normalized || normalized.length < 2) return true;\n  return corpus.includes(normalized);\n}\n\nfunction removeUnsupportedNamedEntities(answer, payload = {}, question = '') {\n  const corpus = evidenceCorpus(payload, question);\n  const kept = sentences(answer).filter((sentence) => {\n    const matches = [...String(sentence || '').matchAll(NAMED_ENTITY_RE)];\n    if (!matches.length) return true;\n    return matches.every((match) => {\n      const token = clean(match[1] || match[2] || match[3], 120);\n      return namedEntitySupported(token, corpus);\n    });\n  });\n  return clean(kept.join(''), 12000);\n}\n",
    'named entity evidence guard',
)

entry_replace(
    "  if (DYNAMIC_FACT_RE.test(question) && !hasEvidence) {\n    const guarded = removeUnsupportedDynamicSpecifics(answer, question);\n    if (guarded !== answer) reasons.push('dynamic_specifics_require_external_evidence');\n    answer = guarded || '現在値や具体的な番号は、根拠を確認できた項目だけ案内します。';\n  }\n",
    "  if (DYNAMIC_FACT_RE.test(question) && !hasEvidence) {\n    const guarded = removeUnsupportedDynamicSpecifics(answer, question);\n    if (guarded !== answer) reasons.push('dynamic_specifics_require_external_evidence');\n    answer = guarded || '現在値や具体的な番号は、根拠を確認できた項目だけ案内します。';\n  }\n\n  if (EVIDENCE_REQUIRED_RE.test(question)) {\n    const guarded = removeUnsupportedNamedEntities(answer, payload, question);\n    if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');\n    answer = guarded;\n    if (!hasEvidence && !answer) {\n      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';\n    }\n  }\n",
    'broad evidence gate',
)

entry_replace(
    "  removeUnauthorizedTransitRouteClaims,\n  gateTurnPayload,",
    "  removeUnauthorizedTransitRouteClaims,\n  removeUnsupportedNamedEntities,\n  gateTurnPayload,",
    'test export named entity guard',
)

entry_path.write_text(entry)

# Broaden worker routing so the weaker model is not asked to answer factual
# questions from memory when a retrieval route is available.
worker_path = Path('src/worker-v44.js')
worker = worker_path.read_text()


def worker_replace(old, new, label):
    global worker
    if old not in worker:
        raise SystemExit(f'missing worker patch anchor: {label}')
    worker = worker.replace(old, new, 1)


worker_replace(
    "const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;",
    "const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;\nconst REAL_WORLD_ENTITY_RE = /(店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|商品|製品|型番|モデル|人物|社長|CEO|住所|所在地|電話番号|連絡先|営業時間|営業日|定休日|予約|アクセス|最寄り|公式サイト|ホームページ|実在|存在)/i;\nconst FACTUAL_QUESTION_RE = /(とは|って何|何(?:です|なの|か|が)|誰|どこ|いつ|何年|何月|何日|何時|何曜日|どの|どれ|違い|比較|特徴|仕様|性能|対応|互換|適合|使える|実在|存在|ある(?:の|か)|ありますか|教えて|知りたい|標高|人口|面積|発売日)/i;\nconst LOCAL_TRANSFORM_RE = /(要約|翻訳|言い換え|添削|校正|文案|メール|返信文|台本|文章|コピー|タイトル|見出し|整形|書き換え|作文)/i;\nconst LOCAL_ADVICE_RE = /(相談|悩み|どうすれば|どうしたら|アイデア|考えて|方針|作戦|整理して)/i;\nconst RECOMMENDATION_RE = /(おすすめ|候補|選ん|どれがいい|何がいい|どこがいい|近く|周辺|買うなら|販売店|店舗|店を探|病院|ホテル|飲食店|レストラン|カフェ)/i;",
    'evidence-first router regexes',
)

worker_replace(
    "function ambiguousLocation(text) {\n  const value = canonicalizeInput(text, 1800);\n  if (!/中央区/.test(value)) return false;\n  return !/(東京都|東京23区|大阪市|大阪府|札幌市|札幌|神戸市|神戸|福岡市|福岡県|千葉市|さいたま市|相模原市|新潟市|浜松市|熊本市)/.test(value);\n}\n",
    "function ambiguousLocation(text) {\n  const value = canonicalizeInput(text, 1800);\n  if (!/中央区/.test(value)) return false;\n  return !/(東京都|東京23区|大阪市|大阪府|札幌市|札幌|神戸市|神戸|福岡市|福岡県|千葉市|さいたま市|相模原市|新潟市|浜松市|熊本市)/.test(value);\n}\n\nexport function shouldGroundFactualTurn(text, history = []) {\n  const value = canonicalizeInput(text, 1800);\n  const hist = historyOf(history);\n  const resolved = fallbackResolvedQuestion(value, hist);\n  if (!value) return false;\n  if (NO_EXTERNAL_RE.test(value)) return false;\n  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || SUBJECTIVE_RE.test(value) || CAPABILITY_RE.test(value)) return false;\n  if ((LOCAL_TRANSFORM_RE.test(value) || LOCAL_ADVICE_RE.test(value)) && !EXPLICIT_LOOKUP_RE.test(value) && !DYNAMIC_FACT_RE.test(value) && !REAL_WORLD_ENTITY_RE.test(value)) return false;\n  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value) || REAL_WORLD_ENTITY_RE.test(value) || RECOMMENDATION_RE.test(value)) return true;\n  if (FACTUAL_QUESTION_RE.test(value)) return true;\n  if (/[？?]$/.test(value) && !LOCAL_TRANSFORM_RE.test(value) && !LOCAL_ADVICE_RE.test(value)) return true;\n  return value.length <= 48 && FACTUAL_QUESTION_RE.test(resolved);\n}\n",
    'shouldGroundFactualTurn',
)

worker_replace(
    "  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };\n  }\n  return { mode: 'casual', webSearch: false, noExternal: false, reason: 'stable_or_conversational' };",
    "  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };\n  }\n  if (shouldGroundFactualTurn(value, hist)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'factual_verification_default' };\n  }\n  return { mode: 'casual', webSearch: false, noExternal: false, reason: 'stable_or_conversational' };",
    'factual default routing',
)

worker_replace(
    "- 根拠にない店名、価格、住所、型番、数値を作らない。\n- 交通経路では、取得根拠に明記されていない乗換駅・路線名・列車名・駅順を内部知識で補わない。",
    "- 根拠にない店名、会社名、施設名、人物名、商品名、価格、住所、型番、数値を作らない。名前が似ていても補完・推測しない。\n- 実在する店・会社・施設・人物・商品を挙げる場合、その名称そのものが取得根拠に現れているものだけを使う。検索結果にない候補を知識から足さない。\n- おすすめ・候補提示では、利用者の条件に合うことを根拠で確認できた候補だけを出す。未確認条件を勝手に満たす扱いにしない。\n- ある候補の住所・価格・営業時間・仕様を別候補へ混ぜない。根拠が矛盾する場合は断定せず、確認できた範囲を分ける。\n- 交通経路では、取得根拠に明記されていない乗換駅・路線名・列車名・駅順を内部知識で補わない。",
    'grounded prompt broad entity lock',
)

worker_replace(
    "  const evidence = evidenceBlock(search);\n  const coverage = search?.coverage || {};\n  const prompt = `利用者の質問: ${canonicalizeInput(body?.text, 1800)}",
    "  const evidence = evidenceBlock(search);\n  const coverage = search?.coverage || {};\n  const candidateType = clean(search?.candidateType || '', 60);\n  const lockedCandidates = Array.isArray(search?.candidateNames) ? search.candidateNames.map((x) => clean(x, 120)).filter(Boolean).slice(0, 8) : [];\n  const candidateLock = candidateType && candidateType !== 'none'\n    ? (lockedCandidates.length\n      ? `\\n候補名ロック: この回答で新しく候補として挙げてよい名称は次だけです: ${lockedCandidates.join(' / ')}。この一覧外の候補名を追加しないでください。`\n      : '\\n候補名ロック: 検索で実在と条件適合を確認できる候補名が得られていません。具体的な候補名を新規に作らず、確認不足を明示してください。')\n    : '';\n  const prompt = `利用者の質問: ${canonicalizeInput(body?.text, 1800)}",
    'candidate lock synthesis prelude',
)

worker_replace(
    "${evidence || '(直接使える根拠は取得できなかった)'}\n\n上のルールに従って利用者へ直接答えてください。`;",
    "${evidence || '(直接使える根拠は取得できなかった)'}${candidateLock}\n\n上のルールに従って利用者へ直接答えてください。`;",
    'candidate lock synthesis prompt',
)

worker_replace(
    "  structuredCoverageIsWholeQuestion,\n  guardUnsupportedTransitEntities,",
    "  structuredCoverageIsWholeQuestion,\n  shouldGroundFactualTurn,\n  guardUnsupportedTransitEntities,",
    'worker test export',
)

worker_path.write_text(worker)

# Add verified local candidates from Nominatim to the staged search state.  This
# gives the answer synthesizer an explicit allow-list instead of letting the
# language model invent local businesses.
search_path = Path('src/search-v45.js')
search = search_path.read_text()


def search_replace(old, new, label):
    global search
    if old not in search:
        raise SystemExit(f'missing search patch anchor: {label}')
    search = search.replace(old, new, 1)


search_replace(
    "function verificationFacets(candidates, plan) {",
    "function extractLocalCandidates(results, limit = 6) {\n  const out = [], seen = new Set();\n  for (const item of results || []) {\n    if (!/openstreetmap-(?:nominatim|direct)/i.test(`${item?.engine || ''} ${item?.probeEngine || ''}`)) continue;\n    const name = clean(item?.title, 100);\n    const key = normalize(name);\n    if (!name || name.length < 2 || name.length > 80 || seen.has(key)) continue;\n    if (/^(?:地図|検索結果|日本|大分県|別府市|東京都|大阪府|福岡県)$/i.test(name)) continue;\n    seen.add(key);\n    out.push({ name, type: 'local_entity', evidence: clean(item?.snippet || item?.excerpt, 220) });\n    if (out.length >= limit) break;\n  }\n  return out;\n}\n\nfunction verificationFacets(candidates, plan) {",
    'local candidate extractor',
)

search_replace(
    "    timings.localMs = Date.now()-t;\n  }\n\n  if (SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED && plan.researchMode === 'discover_then_verify'",
    "    timings.localMs = Date.now()-t;\n    if (['store','place','company','service'].includes(plan.candidateType)) {\n      candidates = extractLocalCandidates(merged, 6);\n    }\n  }\n\n  if (SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED && plan.researchMode === 'discover_then_verify'",
    'populate local candidates',
)

search_replace(
    "  const sufficient = plan.researchMode === 'discover_then_verify'\n    ? Boolean(candidates.length && evidenceUseful)\n    : evidenceUseful;",
    "  const entityCandidateRequired = ['store','place','company','service'].includes(plan.candidateType);\n  const sufficient = plan.researchMode === 'discover_then_verify'\n    ? Boolean(candidates.length && evidenceUseful)\n    : entityCandidateRequired\n      ? Boolean(candidates.length && evidenceUseful)\n      : evidenceUseful;",
    'local candidate sufficiency',
)

search_replace(
    "export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates, isPriceQuestion, concreteMoneyMentions, hasConcretePriceEvidence, priceRecoveryFacets };",
    "export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates, extractLocalCandidates, isPriceQuestion, concreteMoneyMentions, hasConcretePriceEvidence, priceRecoveryFacets };",
    'search test export',
)

search_path.write_text(search)

# Update revision assertions left by earlier cutover tests.
cutover = Path('tests/gemini-api-cutover-v47.test.mjs')
cutover_text = cutover.read_text()
old = "assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v48-interrupt-transit-speed-r1');"
if old not in cutover_text:
    raise SystemExit('missing old cutover revision assertion')
cutover.write_text(cutover_text.replace(old, "assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v54-evidence-first-r1');", 1))

jst_test = Path('tests/jst-router-v53.test.mjs')
jst_text = jst_test.read_text()
old = "assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v53-router-first-jst-r1');"
if old not in jst_text:
    raise SystemExit('missing JST revision assertion')
jst_test.write_text(jst_text.replace(old, "assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v54-evidence-first-r1');", 1))

Path('tests/evidence-first-v54.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, shouldGroundFactualTurn } from '../src/worker-v44.js';
import { __test as entryTest } from '../src/entry.js';
import { __test as searchTest } from '../src/search-v45.js';

const { gateTurnPayload } = entryTest;
const { extractLocalCandidates } = searchTest;

test('real-world details and compatibility questions are grounded by default', () => {
  for (const q of [
    'MILK HALLの電話番号は？',
    '別府で実在する中古PC店を3つ教えて',
    'QCM1250とこのACアダプタは互換性ある？',
    'この型番はWindows 11に対応してる？',
    'このホテルの営業時間は？',
  ]) {
    assert.equal(shouldGroundFactualTurn(q, []), true, q);
    const decision = classifyTurn(q, []);
    assert.equal(decision.mode, 'external', q);
    assert.equal(decision.webSearch, true, q);
  }
});

test('pure transformation and personal advice remain local unless current facts are requested', () => {
  assert.equal(classifyTurn('この文章を短く要約して', []).mode, 'casual');
  assert.equal(classifyTurn('メールの返信文を整えて', []).mode, 'casual');
  assert.equal(classifyTurn('仕事の進め方を一緒に考えて', []).mode, 'casual');
  assert.equal(classifyTurn('最新情報を調べて要約して', []).mode, 'external');
});

test('unsupported invented named businesses are removed when evidence does not contain the name', () => {
  const result = gateTurnPayload({
    answer: '別府なら架空パソコン工房がおすすめです。営業時間は10時からです。',
    search: true,
    searchUseful: false,
    sources: [],
    apiSources: [],
  }, '別府でおすすめの中古PC店は？');
  assert.doesNotMatch(result.answer, /架空パソコン工房/);
  assert.match(result.answer, /根拠|確認/);
  assert.equal(result.truthGate.applied, true);
});

test('a named business present in retrieved source titles survives the entity gate', () => {
  const result = gateTurnPayload({
    answer: '実在PC工房という店舗を確認できました。',
    search: true,
    searchUseful: true,
    sources: [{ title: '実在PC工房 - 別府市の中古パソコン店', url: 'https://example.com/shop', engine: 'test' }],
    apiSources: [],
  }, '別府で中古PC店を教えて');
  assert.match(result.answer, /実在PC工房/);
});

test('local candidate allow-list is built only from OSM/Nominatim evidence', () => {
  const candidates = extractLocalCandidates([
    { title: '実在ショップ', engine: 'openstreetmap-nominatim', snippet: '別府市...' },
    { title: '怪しい記事のおすすめ10選', engine: 'bing-html', snippet: '...' },
  ]);
  assert.deepEqual(candidates.map((x) => x.name), ['実在ショップ']);
});
''')

print('patched broad evidence-first hallucination safeguards')
