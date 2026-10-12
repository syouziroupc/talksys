import fs from 'node:fs';

// Guarded one-off patch: only the obsolete weather smoke assertion is replaced.
const path = '.github/workflows/deploy.yml';
const before = fs.readFileSync(path, 'utf8');
const oldLine = `          OUT="$out" node -e "const d=JSON.parse(process.env.OUT||'{}');const rescue=String(d.route||'').startsWith('cloudflare-region-rescue:');const groundingRecovery=d.route==='gemini-generate-content-grounding-recovery';if(!d.ok||!(d.route==='gemini-native-interactions'||groundingRecovery||rescue)||d.search!==true||d.personalizationRevision!=='talksys-v87-jst-location-personalization-r1'||!String(d.answer||'').trim()||(!rescue&&(d.nativeGoogleSearch!==true||d.generationProvider!=='gemini'||d.generationModel!=='gemini-3.5-flash-lite'))||(groundingRecovery&&d.generationTransport!=='generateContent')||(rescue&&d.generationProvider!=='workers-ai'))throw new Error(process.env.OUT);"`;
const newLine = `          OUT="$out" node -e "const d=JSON.parse(process.env.OUT||'{}');const a=String(d.answer||'');const jmaSource=(d.sources||[]).some(s=>{try{return new URL(String(s?.url||'')).hostname==='www.jma.go.jp'}catch{return false}});const legacy=/推測では答えません|確認できる根拠を十分に取得できなかったため/.test(a);if(!d.ok||d.route!=='structured-jma-weather'||d.search!==true||d.personalizationRevision!=='talksys-v87-jst-location-personalization-r1'||!a.trim()||legacy||d.generationProvider!=='jma'||d.generationModel!=='jma-forecast-json'||d.generationTransport!=='jma-json'||d.groundingEvidencePassed!==true||Number(d.groundingSourceCount||0)<1||!jmaSource||!a.includes('気象庁')||!String(d.jmaReportDatetime||'').trim()||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(d.jmaTargetDate||'')))throw new Error(process.env.OUT);"`;
const first = before.indexOf(oldLine);
if (first < 0) throw new Error('v122 weather smoke anchor not found');
if (before.indexOf(oldLine, first + oldLine.length) >= 0) throw new Error('v122 weather smoke anchor is ambiguous');
const after = before.slice(0, first) + newLine + before.slice(first + oldLine.length);
fs.writeFileSync(path, after);
console.log('v122 production weather smoke updated');
