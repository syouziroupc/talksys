const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TalkSys</title>
  <style>
    *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f4f5;color:#18181b}.app{max-width:760px;height:100vh;margin:0 auto;display:flex;flex-direction:column;background:#fff}.head{padding:16px 20px;border-bottom:1px solid #e4e4e7;font-weight:700}.chat{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:12px}.msg{max-width:82%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;line-height:1.55}.user{align-self:flex-end;background:#18181b;color:#fff}.assistant{align-self:flex-start;background:#f1f1f3}.composer{display:flex;gap:8px;padding:14px;border-top:1px solid #e4e4e7}.composer textarea{flex:1;resize:none;min-height:48px;max-height:140px;padding:12px;border:1px solid #d4d4d8;border-radius:12px;font:inherit}.composer button{border:0;border-radius:12px;padding:0 18px;background:#18181b;color:#fff;font-weight:700;cursor:pointer}.composer button:disabled{opacity:.5;cursor:default}.status{font-size:12px;color:#71717a;padding:0 14px 10px}
  </style>
</head>
<body>
  <main class="app">
    <header class="head">TalkSys</header>
    <section id="chat" class="chat"><div class="msg assistant">こんにちは。何でも話してください。</div></section>
    <div id="status" class="status"></div>
    <form id="form" class="composer">
      <textarea id="input" rows="1" placeholder="メッセージを入力"></textarea>
      <button id="send" type="submit">送信</button>
    </form>
  </main>
  <script>
    const form=document.getElementById('form');
    const input=document.getElementById('input');
    const chat=document.getElementById('chat');
    const send=document.getElementById('send');
    const status=document.getElementById('status');
    const messages=[];

    function addMessage(role,text){
      const el=document.createElement('div');
      el.className='msg '+role;
      el.textContent=text;
      chat.appendChild(el);
      chat.scrollTop=chat.scrollHeight;
    }

    async function submit(){
      const text=input.value.trim();
      if(!text||send.disabled)return;
      messages.push({role:'user',content:text});
      addMessage('user',text);
      input.value='';
      send.disabled=true;
      status.textContent='回答中…';
      try{
        const res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages})});
        const data=await res.json();
        if(!res.ok)throw new Error(data.error||'通信に失敗しました');
        messages.push({role:'assistant',content:data.reply});
        addMessage('assistant',data.reply);
      }catch(err){
        addMessage('assistant','エラー: '+err.message);
      }finally{
        send.disabled=false;
        status.textContent='';
        input.focus();
      }
    }

    form.addEventListener('submit',function(e){e.preventDefault();submit()});
    input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit()}});
  </script>
</body>
</html>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, model: MODEL });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSONが不正です" }, 400);
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "messages が必要です" }, 400);
      }

      const history = body.messages
        .slice(-12)
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

      if (history.length === 0 || history[history.length - 1].role !== "user") {
        return json({ error: "最後のメッセージは user である必要があります" }, 400);
      }

      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: "あなたは簡潔で自然な会話をする日本語アシスタントです。必要に応じて他言語にも対応してください。" },
            ...history,
          ],
          max_tokens: 512,
          temperature: 0.6,
        });

        const reply = typeof result?.response === "string" ? result.response.trim() : "";
        if (!reply) return json({ error: "AIから応答を取得できませんでした" }, 502);
        return json({ reply });
      } catch (error) {
        console.error(JSON.stringify({ event: "ai_error", message: String(error?.message || error) }));
        return json({ error: "AI処理に失敗しました" }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
