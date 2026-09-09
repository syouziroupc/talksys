export const SEARCH_TRACE_CLIENT_V32 = String.raw`(() => {
  'use strict';
  const panel = document.getElementById('trace-panel');
  const stage = document.getElementById('trace-stage');
  const resolved = document.getElementById('trace-resolved');
  const queries = document.getElementById('trace-queries');
  const evidence = document.getElementById('trace-evidence');
  const log = document.getElementById('trace-log');
  const toggle = document.getElementById('trace-toggle');
  if (!panel || !stage || !resolved || !queries || !evidence || !log) return;

  const entries = [];
  let activeTurn = 0;
  let searchActive = false;

  const phaseLabels = {
    received: '入力を受け付けました',
    routing: '回答方法を判断中',
    model_waiting: 'GLMで回答生成中',
    model_retry: 'GLMの予備経路で復旧中',
    model_done: '回答生成完了',
    searching: 'Web検索中',
    planning: '検索課題を整理中',
    plan_ready: '検索課題を確定',
    recovery: '補助検索中',
    reranking: '関連度を評価中',
    evidence_ready: '根拠を選定',
    answering: '根拠から回答生成中',
    auditing: '根拠監査中',
    tts: 'MeloTTS音声生成中',
    done: '完了',
    failed: '復旧処理中',
  };

  function safe(value, fallback = '—') {
    const text = String(value || '').trim();
    return text || fallback;
  }
  function elapsed(data) {
    const ms = Number(data?.elapsedMs || 0);
    return ms > 0 ? ' (' + (ms >= 1000 ? (ms / 1000).toFixed(1) + '秒' : ms + 'ms') + ')' : '';
  }
  function addLog(message) {
    const value = String(message || '').trim();
    if (!value) return;
    if (entries.at(-1)?.endsWith('  ' + value)) return;
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    entries.push(time + '  ' + value);
    while (entries.length > 18) entries.shift();
    log.textContent = entries.join('\n');
  }
  function setStage(phase) {
    stage.textContent = phaseLabels[phase] || safe(phase, '処理中');
  }

  function renderTurn(data) {
    if (!data) return;
    panel.hidden = false;
    if (data.phase === 'received') {
      activeTurn += 1;
      searchActive = false;
      resolved.textContent = 'Web検索なし（会話応答）';
      queries.textContent = '—';
      evidence.textContent = '—';
    }
    setStage(data.phase);
    const model = data.model ? ' / ' + data.model : '';
    const message = safe(data.message, phaseLabels[data.phase] || data.phase);
    addLog(message + model + elapsed(data));
  }

  function renderSearch(data) {
    if (!data) return;
    panel.hidden = false;
    searchActive = true;
    setStage(data.phase);
    if (data.resolvedQuestion) resolved.textContent = safe(data.resolvedQuestion);
    if (Array.isArray(data.queries) && data.queries.length) queries.textContent = data.queries.slice(0, 8).map((q, i) => (i + 1) + '. ' + q).join('\n');
    if (typeof data.evidenceCount === 'number') {
      const titles = Array.isArray(data.sources) ? data.sources.slice(0, 5).map((s) => String(s?.title || '').trim()).filter(Boolean) : [];
      evidence.textContent = '根拠候補 ' + data.evidenceCount + '件' + (titles.length ? '\n' + titles.join('\n') : '');
    }
    addLog(safe(data.message, phaseLabels[data.phase] || data.phase) + elapsed(data));
  }

  if (toggle) toggle.addEventListener('click', () => {
    const compact = panel.classList.toggle('compact');
    toggle.textContent = compact ? '処理詳細を開く' : '処理詳細を閉じる';
  });

  window.addEventListener('talksys-turn-trace', (event) => renderTurn(event.detail));
  window.addEventListener('talksys-search-trace', (event) => renderSearch(event.detail));
  window.addEventListener('talksys-model-route', (event) => {
    panel.hidden = false;
    addLog('回答モデル: ' + safe(event.detail?.model, 'GLM-5.3 Flash') + ' / ' + safe(event.detail?.tier, '自動'));
  });
  window.addEventListener('talksys-melo-audio', (event) => {
    const bytes = Number(event.detail?.bytes || 0);
    addLog('MeloTTS音声を受信' + (bytes > 0 ? ' (' + Math.round(bytes / 1024) + 'KB)' : ''));
  });
  window.addEventListener('talksys-melo-tts-error', (event) => addLog('MeloTTS音声生成エラー: ' + safe(event.detail?.message, '不明')));
})();
`;
