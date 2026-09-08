const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TalkSys 電話相談</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f4f5;color:#18181b}
    button,textarea{font:inherit}
    .app{max-width:1120px;min-height:100vh;margin:0 auto;display:flex;flex-direction:column;background:#fff}
    .head{padding:18px 22px 14px;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;background:#fff;z-index:5}
    .brand{display:flex;flex-direction:column;gap:3px}.title{font-weight:800;font-size:18px}.sub{font-size:12px;color:#71717a}
    .btn{border:1px solid #d4d4d8;border-radius:999px;background:#18181b;color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;min-height:48px}.btn.active{background:#b91c1c;border-color:#b91c1c}.btn:disabled{opacity:.45;cursor:default}
    .hero{padding:17px 22px;border-bottom:1px solid #e4e4e7;background:#fafafa}.hero strong{display:block;margin-bottom:5px}.hero p{margin:0;color:#52525b;font-size:13px;line-height:1.65}
    .workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;flex:1;min-height:0}
    .conversation{min-width:0;display:flex;flex-direction:column;border-right:1px solid #e4e4e7}
    .chat{flex:1;overflow:auto;padding:26px 24px;display:flex;flex-direction:column;gap:12px;min-height:420px}.msg{max-width:88%;padding:11px 14px;border-radius:14px;white-space:pre-wrap;line-height:1.55;overflow-wrap:anywhere}.user{align-self:flex-end;background:#18181b;color:#fff}.assistant{align-self:flex-start;background:#f1f1f3}
    .status{min-height:40px;font-size:13px;color:#52525b;padding:9px 22px 13px;border-top:1px solid #f4f4f5}
    .text-note{padding:10px 22px 0;color:#71717a;font-size:12px;line-height:1.5}
    .composer{padding:10px 22px 20px;display:flex;gap:8px;background:#fff}.composer textarea{flex:1;min-width:0;resize:vertical;min-height:52px;max-height:140px;padding:12px;border:1px solid #a1a1aa;border-radius:12px;line-height:1.45}.composer button{border:0;border-radius:12px;background:#18181b;color:#fff;padding:0 17px;font-weight:800;cursor:pointer;white-space:nowrap}
    .trace{background:#fafafa;padding:18px 16px;overflow:auto}.trace[hidden]{display:none}.trace-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:13px}.trace-title{font-weight:800;font-size:14px}.trace-help{font-size:11px;line-height:1.45;color:#71717a;margin-top:3px}.trace-toggle{border:0;background:transparent;color:#52525b;font-size:11px;text-decoration:underline;cursor:pointer;padding:2px}
    .trace-grid{display:flex;flex-direction:column;gap:10px}.trace-card{border:1px solid #e4e4e7;border-radius:12px;background:#fff;padding:10px 11px}.trace-label{font-size:10px;font-weight:800;letter-spacing:.04em;color:#71717a;margin-bottom:5px}.trace-value{font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.trace-stage{font-weight:800}.trace-log{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.55;white-space:pre-wrap;color:#52525b;max-height:180px;overflow:auto}.trace.compact .trace-card:not(:first-child){display:none}.trace.compact .trace-help{display:none}
    @media(max-width:820px){.app{min-height:100dvh}.workspace{display:flex;flex-direction:column}.conversation{border-right:0}.trace{order:-1;border-bottom:1px solid #e4e4e7;padding:12px}.trace-grid{display:grid;grid-template-columns:1fr 1fr}.trace-card:last-child{grid-column:1/-1}.chat{padding:14px;min-height:330px}.head{padding:12px}.title{font-size:16px}.btn{padding:10px 14px;min-height:44px}.hero{padding:14px 12px}.msg{max-width:94%}.status{padding:8px 12px 12px}.text-note{padding:10px 12px 0}.composer{padding:10px 12px 14px}}
    @media(max-width:520px){.trace-grid{display:flex}.trace{max-height:360px}.composer button{padding:0 12px}}
  </style>
</head>
<body>
  <main class="app">
    <header class="head">
      <div class="brand"><div class="title">TalkSys</div><div class="sub">電話相談モード</div></div>
      <button id="voice" class="btn" type="button">☎ リアルタイム通話</button>
    </header>
    <section class="hero">
      <strong>検索は会話の流れを踏まえて、精度優先で行います。</strong>
      <p>「安いのがいい」「どこで買う？」のような省略も、同じ通話・接続内の直前の相談内容から対象・用途・予算を復元してから検索します。</p>
    </section>
    <section class="workspace">
      <div class="conversation">
        <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンで話せます。外で話せないときは、下の文字入力を発話として送れます。</div></section>
        <div id="status" class="status"></div>
        <div class="text-note">文字入力も同じ会話として扱います。直前の相談内容を引き継いで回答・検索し、返事は文字と音声で再生します。</div>
        <form id="form" class="composer"><textarea id="input" rows="2" aria-label="発話テスト入力" placeholder="ここに入力すると、話したこととして送信します"></textarea><button id="send" type="submit">話したことにする</button></form>
      </div>
      <aside id="trace-panel" class="trace" aria-live="polite">
        <div class="trace-head">
          <div><div class="trace-title">AI処理ビュー</div><div class="trace-help">内部の推論文ではなく、検索課題・検索語・根拠選定・監査など実際に実行した処理段階を表示します。</div></div>
          <button id="trace-toggle" class="trace-toggle" type="button">処理詳細を閉じる</button>
        </div>
        <div class="trace-grid">
          <div class="trace-card"><div class="trace-label">現在の処理</div><div id="trace-stage" class="trace-value trace-stage">待機中</div></div>
          <div class="trace-card"><div class="trace-label">会話から解決した検索課題</div><div id="trace-resolved" class="trace-value">—</div></div>
          <div class="trace-card"><div class="trace-label">実際に使う検索語</div><div id="trace-queries" class="trace-value">—</div></div>
          <div class="trace-card"><div class="trace-label">採用した根拠</div><div id="trace-evidence" class="trace-value">—</div></div>
          <div class="trace-card"><div class="trace-label">処理ログ</div><div id="trace-log" class="trace-log">まだ検索していません。</div></div>
        </div>
      </aside>
    </section>
  </main>
  <script src="/search-trace.js"></script>
  <script src="/cloudflare-live.js"></script>
</body>
</html>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, mode: 'phone-consultation-only', screenCapture: false, overlay: false, contextualSearchTrace: true });
    }
    return new Response('Not Found', { status: 404 });
  },
};
