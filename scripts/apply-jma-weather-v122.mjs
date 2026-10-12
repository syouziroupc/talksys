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
    "const GEMINI_GENERATE_CONTENT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;",
    "const GEMINI_GENERATE_CONTENT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;\nconst JMA_AREA_ENDPOINT = 'https://www.jma.go.jp/bosai/common/const/area.json';\nconst JMA_FORECAST_BASE = 'https://www.jma.go.jp/bosai/forecast/data/forecast';\nexport const JMA_WEATHER_REVISION = 'talksys-jma-weather-v122-r1';\nlet jmaAreaCache = null;\nlet jmaAreaCacheAt = 0;",
    'JMA endpoints and revision',
  );

  s = replaceOnce(
    s,
    `function deterministicLocationClarificationResult(text = '', body = {}, started = Date.now()) {\n  const value = compact(text, 500);`,
    `export function isJmaWeatherQuestion(text = '') {\n  const value = compact(text, 500);\n  return Boolean(value && /(?:天気|天候|降水|雨|雪)/i.test(value));\n}\n\nfunction jmaTargetDateKey(text = '', now = new Date()) {\n  const shifted = new Date(now.getTime() + JST_OFFSET_MS);\n  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());\n  const offsetDays = /明日/.test(compact(text, 500)) ? 1 : 0;\n  return new Date(base + offsetDays * 86400000).toISOString().slice(0, 10);\n}\n\nexport function resolveJmaWeatherArea(areaMap = {}, text = '') {\n  const value = compact(text, 1000);\n  if (!value) return null;\n  const matches = Object.entries(areaMap?.class20s || {})\n    .filter(([, item]) => item?.name && value.includes(String(item.name)))\n    .sort((a, b) => String(b[1]?.name || '').length - String(a[1]?.name || '').length);\n  if (!matches.length) return null;\n  const [locationCode, location] = matches[0];\n  const class15Code = String(location?.parent || '');\n  const class15 = areaMap?.class15s?.[class15Code] || {};\n  const class10Code = String(class15?.parent || class15Code);\n  const class10 = areaMap?.class10s?.[class10Code] || areaMap?.class10s?.[class15Code] || {};\n  const weatherAreaCode = String(class10Code || class15Code);\n  const officeCode = String(class10?.parent || '');\n  const office = areaMap?.offices?.[officeCode] || {};\n  if (!weatherAreaCode || !officeCode || !office?.name) return null;\n  return {\n    locationCode: String(locationCode),\n    locationName: compact(location?.name, 120),\n    weatherAreaCode,\n    weatherAreaName: compact(class10?.name || class15?.name, 120),\n    officeCode,\n    officeName: compact(office?.name, 120),\n    publishingOffice: compact(office?.officeName, 160),\n  };\n}\n\nexport function jmaWeatherAnswer(forecastPayload = [], resolved = null, text = '', now = new Date()) {\n  if (!resolved?.weatherAreaCode) throw new Error('jma_weather_area_missing');\n  const document = Array.isArray(forecastPayload) ? forecastPayload[0] : null;\n  if (!document || !Array.isArray(document?.timeSeries)) throw new Error('jma_forecast_document_missing');\n  const series = document.timeSeries.find((item) => Array.isArray(item?.areas) && item.areas.some((area) => String(area?.area?.code || '') === resolved.weatherAreaCode && Array.isArray(area?.weathers)));\n  if (!series) throw new Error('jma_weather_series_missing');\n  const area = series.areas.find((item) => String(item?.area?.code || '') === resolved.weatherAreaCode && Array.isArray(item?.weathers));\n  if (!area) throw new Error('jma_weather_area_series_missing');\n  const targetDate = jmaTargetDateKey(text, now);\n  const index = (series.timeDefines || []).findIndex((value) => String(value || '').slice(0, 10) === targetDate);\n  if (index < 0 || !area.weathers[index]) throw new Error('jma_weather_date_missing');\n  const weather = compact(String(area.weathers[index] || '').replace(/[　 ]+/g, ' '), 500);\n  if (!weather) throw new Error('jma_weather_text_missing');\n  const dayLabel = /明日/.test(compact(text, 500)) ? '明日は' : '今日は';\n  const regionLabel = compact(`${resolved.officeName || ''}${resolved.weatherAreaName || ''}`, 180);\n  return {\n    answer: `気象庁の予報では、${resolved.locationName}を含む${regionLabel}は${dayLabel}${weather}です。`,\n    reportDatetime: compact(document?.reportDatetime || '', 120),\n    targetDate,\n    publishingOffice: compact(document?.publishingOffice || resolved.publishingOffice || '', 160),\n  };\n}\n\nasync function fetchJmaJson(url, signal) {\n  const response = await fetch(url, { headers: { accept: 'application/json' }, signal });\n  if (!response.ok) throw new Error(`jma_http_${response.status}`);\n  return response.json();\n}\n\nasync function loadJmaAreaMap(signal) {\n  const now = Date.now();\n  if (jmaAreaCache && now - jmaAreaCacheAt < 6 * 60 * 60 * 1000) return jmaAreaCache;\n  const value = await fetchJmaJson(JMA_AREA_ENDPOINT, signal);\n  jmaAreaCache = value;\n  jmaAreaCacheAt = now;\n  return value;\n}\n\nexport async function deterministicJmaWeatherResult(text = '', now = new Date(), signal) {\n  const started = Date.now();\n  if (!isJmaWeatherQuestion(text) || !EXPLICIT_LOCATION_RE.test(compact(text, 1000))) return null;\n  const areaMap = await loadJmaAreaMap(signal);\n  const resolved = resolveJmaWeatherArea(areaMap, text);\n  if (!resolved) return null;\n  const sourceUrl = `${JMA_FORECAST_BASE}/${encodeURIComponent(resolved.officeCode)}.json`;\n  const forecast = await fetchJmaJson(sourceUrl, signal);\n  const weather = jmaWeatherAnswer(forecast, resolved, text, now);\n  const answer = simplifyForSenior(normalizeSpokenJapanese(weather.answer));\n  const source = { title: `${weather.publishingOffice || resolved.publishingOffice || '気象庁'} 天気予報`, url: sourceUrl, engine: 'jma-official-forecast' };\n  return {\n    ok: true,\n    answer,\n    route: 'structured-jma-weather',\n    planner: JMA_WEATHER_REVISION,\n    search: true,\n    searchUseful: true,\n    searchPolicy: 'official-jma-forecast-json',\n    searchRetried: false,\n    genericVerificationAttempted: false,\n    genericVerificationSucceeded: false,\n    genericVerificationRevision: GENERIC_VERIFICATION_REVISION,\n    verifierSearched: false,\n    verificationFailOpen: false,\n    groundingRequired: true,\n    groundingHighRisk: true,\n    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n    groundingAnswerRevision: GROUNDING_ANSWER_REVISION,\n    groundingEvidencePassed: true,\n    groundingEvidenceReasons: [],\n    groundingCitationCount: 0,\n    groundingCitationSpanCount: 0,\n    groundingSourceCount: 1,\n    groundingSearchPerformed: true,\n    groundingUnsupportedClaimCount: 0,\n    groundingUnsupportedHardClaimCount: 0,\n    groundingFailClosed: false,\n    groundingClarification: false,\n    groundingRecoveryUsed: true,\n    temporalTransitGuard: false,\n    temporalTransitRevision: TEMPORAL_TRANSIT_REVISION,\n    temporalRepairRetried: false,\n    temporalRepairAttempts: 0,\n    authoritativeJst: currentJstIso(now),\n    queries: [],\n    sources: [source],\n    apiSources: [source],\n    interactionId: '',\n    interactionStatus: 'completed',\n    interactionReset: true,\n    interactionsRegionFallback: false,\n    generationTransport: 'jma-json',\n    fallbackReason: 'official-weather-source',\n    model: 'jma-forecast-json',\n    generationProvider: 'jma',\n    generationModel: 'jma-forecast-json',\n    personalizationRevision: PERSONALIZATION_REVISION,\n    languageMode: 'ja-spoken',\n    speechOptimized: true,\n    nativeGeminiAnswerPath: false,\n    nativeGoogleSearch: false,\n    groundingEvidenceGate: true,\n    customTruthGateApplied: false,\n    blanketFailClosed: false,\n    legacyGlmExecution: false,\n    jmaWeatherRevision: JMA_WEATHER_REVISION,\n    jmaReportDatetime: weather.reportDatetime,\n    jmaTargetDate: weather.targetDate,\n    timings: { totalMs: Date.now() - started, primaryMs: Date.now() - started, searchRetryMs: 0, verifierMs: 0, searchMs: Date.now() - started },\n  };\n}\n\nfunction deterministicLocationClarificationResult(text = '', body = {}, started = Date.now()) {\n  const value = compact(text, 500);`,
    'JMA weather helpers before location clarification',
  );

  s = replaceOnce(
    s,
    `  const locationClarification = deterministicLocationClarificationResult(text, body, started);\n  if (locationClarification) return locationClarification;\n\n  const immediateTransit = isImmediateTransitQuestion(text);`,
    `  const locationClarification = deterministicLocationClarificationResult(text, body, started);\n  if (locationClarification) return locationClarification;\n\n  if (isJmaWeatherQuestion(text) && EXPLICIT_LOCATION_RE.test(text)) {\n    try {\n      const officialWeather = await deterministicJmaWeatherResult(text, now, signal);\n      if (officialWeather) return officialWeather;\n    } catch (error) {\n      emitLatencyLog('jma-weather-fallback-failed', body, {\n        revision: JMA_WEATHER_REVISION,\n        durationMs: Date.now() - started,\n        error: compact(error?.message || error, 400),\n      }, 'warn');\n    }\n  }\n\n  const immediateTransit = isImmediateTransitQuestion(text);`,
    'use JMA official forecast before Gemini weather lookup',
  );

  s = replaceOnce(
    s,
    `  deterministicLocationClarificationResult,\n  interactionOutputText,`,
    `  deterministicLocationClarificationResult,\n  isJmaWeatherQuestion,\n  resolveJmaWeatherArea,\n  jmaWeatherAnswer,\n  deterministicJmaWeatherResult,\n  interactionOutputText,`,
    'export JMA helpers for tests',
  );
  return s;
});

write('src/telephony/index.js', (source) => {
  let s = source;
  s = replaceOnce(s, "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v121-r1';", "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v122-r1';", 'v122 runtime log revision');
  s = replaceOnce(s, "export const PHONE_RELEASE_VERSION = 'v121';", "export const PHONE_RELEASE_VERSION = 'v122';", 'v122 release version');
  return s;
});

for (const path of ['tests/phone-quality-personalization-v120.test.mjs', 'tests/phone-grounding-profile-v121.test.mjs']) {
  write(path, (source) => source
    .replace("assert.equal(PHONE_RELEASE_VERSION, 'v121');", "assert.equal(PHONE_RELEASE_VERSION, 'v122');")
    .replace("assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v121-r1');", "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v122-r1');"));
}

console.log('v122 JMA weather patch applied');
