const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TalkSys 電話相談</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f4f5;color:#18181b}
    button{font:inherit}
    .app{max-width:760px;min-height:100vh;margin:0 auto;display:flex;flex-direction:column;background:#fff}
    .head{padding:18px 18px 14px;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;background:#fff;z-index:5}
    .brand{display:flex;flex-direction:column;gap:3px}.title{font-weight:800;font-size:18px}.sub{font-size:12px;color:#71717a}
    .btn{border:1px solid #d4d4d8;border-radius:999px;background:#18181b;color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;min-height:48px}.btn.active{background:#b91c1c;border-color:#b91c1c}.btn:disabled{opacity:.45;cursor:default}
    .hero{padding:18px;border-bottom:1px solid #e4e4e7;background:#fafafa}.hero strong{display:block;margin-bottom:5px}.hero p{margin:0;color:#52525b;font-size:13px;line-height:1.65}
    .chat{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:12px;min-height:360px}.msg{max-width:88%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;line-height:1.55;overflow-wrap:anywhere}.user{align-self:flex-end;background:#18181b;color:#fff}.assistant{align-self:flex-start;background:#f1f1f3}
    .status{min-height:38px;font-size:13px;color:#52525b;padding:8px 18px 14px;border-top:1px solid #f4f4f5}
    .composer{display:none}
    @media(max-width:620px){.app{min-height:100dvh}.head{padding:12px}.title{font-size:16px}.btn{padding:10px 14px;min-height:44px}.hero{padding:14px 12px}.chat{padding:12px}.msg{max-width:94%}.status{padding:8px 12px 12px}}
  </style>
</head>
<body>
  <main class="app">
    <header class="head">
      <div class="brand"><div class="title">TalkSys</div><div class="sub">電話相談モード</div></div>
      <button id="voice" class="btn" type="button">☎ リアルタイム通話</button>
    </header>
    <section class="hero">
      <strong>検索は精度優先です。</strong>
      <p>最新情報や店・価格・制度などは、会話の文脈を引き継いで複数回検索してから答えます。検索中は少し待つ場合があります。</p>
    </section>
    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンを押して、そのまま話してください。</div></section>
    <div id="status" class="status"></div>
    <form id="form" class="composer" aria-hidden="true"><textarea id="input" rows="1"></textarea><button id="send" type="submit">送信</button></form>
  </main>
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
      return json({ ok: true, mode: 'phone-consultation-only', screenCapture: false, overlay: false });
    }
    return new Response('Not Found', { status: 404 });
  },
};
