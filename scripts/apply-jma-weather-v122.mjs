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

const jmaSnippet = fs.readFileSync('scripts/jma-weather-v122-snippet.txt', 'utf8').trimEnd();

write('src/integrated-entry.js', (source) => {
  let s = source;

  const endpointAnchor = "const GEMINI_GENERATE_CONTENT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;";
  s = replaceOnce(
    s,
    endpointAnchor,
    endpointAnchor + "\nconst JMA_AREA_ENDPOINT = 'https://www.jma.go.jp/bosai/common/const/area.json';\nconst JMA_FORECAST_BASE = 'https://www.jma.go.jp/bosai/forecast/data/forecast';\nexport const JMA_WEATHER_REVISION = 'talksys-jma-weather-v122-r1';\nlet jmaAreaCache = null;\nlet jmaAreaCacheAt = 0;",
    'JMA endpoints and revision',
  );

  const locationAnchor = "function deterministicLocationClarificationResult(text = '', body = {}, started = Date.now()) {\n  const value = compact(text, 500);";
  s = replaceOnce(
    s,
    locationAnchor,
    jmaSnippet + "\n\n" + locationAnchor,
    'JMA weather helpers before location clarification',
  );

  const earlyAnchor = "  const locationClarification = deterministicLocationClarificationResult(text, body, started);\n  if (locationClarification) return locationClarification;\n\n  const immediateTransit = isImmediateTransitQuestion(text);";
  const earlyReplacement = "  const locationClarification = deterministicLocationClarificationResult(text, body, started);\n  if (locationClarification) return locationClarification;\n\n  if (isJmaWeatherQuestion(text) && EXPLICIT_LOCATION_RE.test(text)) {\n    try {\n      const officialWeather = await deterministicJmaWeatherResult(text, now, signal);\n      if (officialWeather) return officialWeather;\n    } catch (error) {\n      emitLatencyLog('jma-weather-fallback-failed', body, {\n        revision: JMA_WEATHER_REVISION,\n        durationMs: Date.now() - started,\n        error: compact(error?.message || error, 400),\n      }, 'warn');\n    }\n  }\n\n  const immediateTransit = isImmediateTransitQuestion(text);";
  s = replaceOnce(s, earlyAnchor, earlyReplacement, 'use JMA official forecast before Gemini weather lookup');

  const testExportAnchor = "  deterministicLocationClarificationResult,\n  interactionOutputText,";
  const testExportReplacement = "  deterministicLocationClarificationResult,\n  isJmaWeatherQuestion,\n  resolveJmaWeatherArea,\n  jmaWeatherAnswer,\n  deterministicJmaWeatherResult,\n  interactionOutputText,";
  s = replaceOnce(s, testExportAnchor, testExportReplacement, 'export JMA helpers for tests');
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
