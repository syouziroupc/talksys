export const SEARCH_TRACE_CLIENT_V23 = String.raw`(() => {
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
  let seenSearch = false;
  let lastEventKey = '';
  let lastEventAt = 0;

  function text(value, fallback = '—') {
    const v = String(value || '').trim();
    return v || fallback;
  }

  function labelPhase(phase) {
    return ({
      planning: '検索課題を整理中',
      plan_ready: '検索課題を確定',
      searching: 'Web検索中',
      recovery: '補助検索中',
      reranking: '関連度を評価中',
      evidence_ready: '根拠を選定',
      answering: '回答生成中',
      answer_retry: '回答経路を切替',
      auditing: '根拠監査中',
      done: '完了',
    })[phase] || text(phase, '処理中');
  }

  function addLog(message) {
    const value = String(message || '').trim();
    if (!value) return;
    const now = new Date();
    const line = now.toLocaleTimeString('ja-JP', { hour12: false }) + '  ' + value;
    if (entries.at(-1)?.endsWith('  ' + value)) return;
    entries.push(line);
    while (entries.length > 12) entries.shift();
    log.textContent = entries.join('\n');
  }

  function render(data) {
    if (!data) return;
    const key = [data.phase || '', data.message || '', data.resolvedQuestion || '', Array.isArray(data.queries) ? data.queries.join('|') : ''].join('::');
    const now = Date.now();
    if (key === lastEventKey && now - lastEventAt < 1200) return;
    lastEventKey = key;
    lastEventAt = now;

    seenSearch = true;
    panel.hidden = false;
    stage.textContent = labelPhase(data.phase);
    if (data.resolvedQuestion) resolved.textContent = text(data.resolvedQuestion);
    if (Array.isArray(data.queries) && data.queries.length) {
      queries.textContent = data.queries.slice(0, 8).map((q, i) => String(i + 1) + '. ' + q).join('\n');
    }
    if (typeof data.evidenceCount === 'number') {
      const titles = Array.isArray(data.sources)
        ? data.sources.slice(0, 5).map((s) => String(s?.title || '').trim()).filter(Boolean)
        : [];
      evidence.textContent = '根拠候補 ' + data.evidenceCount + '件' + (titles.length ? '\n' + titles.join('\n') : '');
    }
    if (Array.isArray(data.answerAttempts) && data.answerAttempts.length) {
      const summary = data.answerAttempts.map((a) => String(a.route || '回答') + ': ' + (a.ok ? '成功' : '切替') + ' ' + Number(a.elapsedMs || 0) + 'ms').join(' / ');
      addLog(summary);
    }
    if (data.auditPassed === true) addLog('根拠監査: 通過');
    else if (data.phase === 'done' && data.auditPassed === false) addLog('根拠監査: 機械的ガードを適用');
    addLog(data.message || labelPhase(data.phase));
  }

  if (toggle) {
    toggle.addEventListener('click', () => {
      const compact = panel.classList.toggle('compact');
      toggle.textContent = compact ? '処理詳細を開く' : '処理詳細を閉じる';
    });
  }

  // v23 live client dispatches the real socket events directly. Do not wrap WebSocket
  // again: doing both was the cause of duplicate processing-log entries in v22.
  window.addEventListener('talksys-search-trace', (event) => render(event.detail));
  window.addEventListener('talksys-model-route', (event) => {
    if (seenSearch) addLog('回答ルート: ' + text(event.detail?.tier, '自動'));
  });
})();
`;
