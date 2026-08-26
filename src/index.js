const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TalkSys</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f4f5;color:#18181b}
    button,textarea{font:inherit}
    .app{max-width:900px;min-height:100vh;margin:0 auto;display:flex;flex-direction:column;background:#fff}
    .head{padding:14px 16px;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;background:#fff;z-index:5}
    .title{font-weight:800}.head-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .btn{border:1px solid #d4d4d8;border-radius:10px;background:#fff;color:#18181b;padding:8px 11px;font-weight:700;cursor:pointer;min-height:40px}
    .btn.primary{background:#18181b;color:#fff;border-color:#18181b}.btn.active{background:#18181b;color:#fff;border-color:#18181b}.btn:disabled{opacity:.45;cursor:default}
    .screen{border-bottom:1px solid #e4e4e7;background:#fafafa}.screen[hidden]{display:none}
    .screen-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px}.screen-tools .hint{margin-left:auto;font-size:12px;color:#71717a;min-width:180px;text-align:right}
    .screen-wrap{position:relative;margin:0 14px 12px;border:1px solid #d4d4d8;border-radius:12px;overflow:hidden;background:#111;line-height:0;cursor:default}
    .screen-wrap.manual{cursor:crosshair}.screen-wrap video{width:100%;height:auto;display:block;max-height:58vh;background:#111}
    .overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.target-note{padding:0 14px 12px;font-size:13px;color:#3f3f46;min-height:20px}
    .privacy{padding:0 14px 10px;font-size:11px;color:#71717a}
    .chat{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:12px;min-height:260px}
    .msg{max-width:82%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;line-height:1.55;overflow-wrap:anywhere}.user{align-self:flex-end;background:#18181b;color:#fff}.assistant{align-self:flex-start;background:#f1f1f3}
    .status{min-height:28px;font-size:12px;color:#71717a;padding:6px 14px 4px}.composer{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid #e4e4e7;position:sticky;bottom:0;background:#fff}
    .composer textarea{flex:1;resize:none;min-height:48px;max-height:140px;padding:12px;border:1px solid #d4d4d8;border-radius:12px}.composer button{border:0;border-radius:12px;padding:0 18px;background:#18181b;color:#fff;font-weight:700;cursor:pointer}.composer button:disabled{opacity:.5;cursor:default}
    @media(max-width:620px){.app{min-height:100dvh}.head{padding:10px}.title{font-size:15px}.head-actions{gap:6px}.btn{padding:7px 9px;font-size:13px}.screen-tools{padding:8px 10px}.screen-tools .hint{width:100%;margin-left:0;text-align:left}.screen-wrap{margin:0 10px 10px}.target-note,.privacy{padding-left:10px;padding-right:10px}.chat{padding:12px}.msg{max-width:92%}.composer{padding:10px}.composer button{padding:0 14px}}
  </style>
</head>
<body>
  <main class="app">
    <header class="head">
      <div class="title">TalkSys</div>
      <div class="head-actions">
        <button id="screenToggle" class="btn" type="button">▣ 画面共有</button>
        <button id="voice" class="btn" type="button" aria-label="音声入力を開始">🎙 音声で話す</button>
      </div>
    </header>

    <section id="screenPanel" class="screen" hidden>
      <div class="screen-tools">
        <button id="locate" class="btn" type="button" disabled>入力内容を指す</button>
        <button id="manual" class="btn" type="button" disabled>手動矢印</button>
        <button id="shot" class="btn" type="button" disabled>PNG保存</button>
        <button id="clearOverlay" class="btn" type="button" disabled>矢印を消す</button>
        <span id="screenHint" class="hint">画面共有を開始してください。</span>
      </div>
      <div id="screenWrap" class="screen-wrap">
        <video id="screenVideo" autoplay playsinline muted></video>
        <svg id="overlay" class="overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"></svg>
      </div>
      <div id="targetNote" class="target-note"></div>
      <div class="privacy">対象位置を自動で探すときだけ現在画面の静止画をAIへ送ります。TalkSys側では保存しません。</div>
    </section>

    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">こんにちは。文字でも音声でも話せます。画面共有中は、操作したい場所を矢印で案内できます。</div></section>
    <div id="status" class="status"></div>
    <form id="form" class="composer">
      <textarea id="input" rows="1" placeholder="メッセージを入力" aria-label="メッセージ"></textarea>
      <button id="send" type="submit">送信</button>
    </form>
  </main>

  <script>
    const form=document.getElementById('form');
    const input=document.getElementById('input');
    const chat=document.getElementById('chat');
    const send=document.getElementById('send');
    const status=document.getElementById('status');
    const voice=document.getElementById('voice');
    const screenToggle=document.getElementById('screenToggle');
    const screenPanel=document.getElementById('screenPanel');
    const screenVideo=document.getElementById('screenVideo');
    const screenWrap=document.getElementById('screenWrap');
    const screenHint=document.getElementById('screenHint');
    const targetNote=document.getElementById('targetNote');
    const overlay=document.getElementById('overlay');
    const locateButton=document.getElementById('locate');
    const manualButton=document.getElementById('manual');
    const shotButton=document.getElementById('shot');
    const clearOverlayButton=document.getElementById('clearOverlay');
    const messages=[];
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    const canSpeak='speechSynthesis' in window&&'SpeechSynthesisUtterance' in window;
    const canCapture=!!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia);
    let recognition=null;
    let listening=false;
    let voiceSession=false;
    let screenStream=null;
    let manualMode=false;
    let locateBusy=false;

    function addMessage(role,text){
      const el=document.createElement('div');
      el.className='msg '+role;
      el.textContent=text;
      chat.appendChild(el);
      el.scrollIntoView({block:'nearest'});
    }

    function speak(text){
      if(!voiceSession||!canSpeak)return;
      window.speechSynthesis.cancel();
      const utterance=new SpeechSynthesisUtterance(text);
      utterance.lang='ja-JP';
      utterance.rate=1;
      utterance.pitch=1;
      utterance.onstart=()=>{status.textContent='読み上げ中…'};
      utterance.onend=()=>{status.textContent='';input.focus()};
      utterance.onerror=()=>{status.textContent='';input.focus()};
      window.speechSynthesis.speak(utterance);
    }

    function setScreenControls(enabled){
      locateButton.disabled=!enabled;
      manualButton.disabled=!enabled;
      shotButton.disabled=!enabled;
      clearOverlayButton.disabled=!enabled;
    }

    function clearOverlay(){
      overlay.replaceChildren();
      targetNote.textContent='';
    }

    function drawArrow(x,y,label){
      const px=Math.max(25,Math.min(975,Number(x)||500));
      const py=Math.max(25,Math.min(975,Number(y)||500));
      const startX=px<500?Math.min(950,px+190):Math.max(50,px-190);
      const startY=py<300?Math.min(950,py+165):Math.max(50,py-165);
      overlay.innerHTML='<defs><marker id="arrowHead" markerWidth="16" markerHeight="16" refX="12" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,12 L14,6 z" fill="#ff3b30"></path></marker></defs><line x1="'+startX+'" y1="'+startY+'" x2="'+px+'" y2="'+py+'" stroke="#ff3b30" stroke-width="16" stroke-linecap="round" marker-end="url(#arrowHead)"></line><circle cx="'+px+'" cy="'+py+'" r="34" fill="none" stroke="#ff3b30" stroke-width="13"></circle>';
      targetNote.textContent=label?'→ '+label:'→ ここです';
      clearOverlayButton.disabled=false;
    }

    function captureFrame(maxWidth=1024,quality=0.78){
      if(!screenStream||!screenVideo.videoWidth||!screenVideo.videoHeight)throw new Error('共有画面の映像がまだ準備できていません');
      const scale=Math.min(1,maxWidth/screenVideo.videoWidth,720/screenVideo.videoHeight);
      const width=Math.max(1,Math.round(screenVideo.videoWidth*scale));
      const height=Math.max(1,Math.round(screenVideo.videoHeight*scale));
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d',{alpha:false});
      if(!ctx)throw new Error('画面画像を作成できません');
      ctx.drawImage(screenVideo,0,0,width,height);
      return {dataUrl:canvas.toDataURL('image/jpeg',quality),canvas};
    }

    async function startCapture(){
      if(!canCapture){addMessage('assistant','このブラウザーではデスクトップキャプチャーに対応していません。ChromeまたはEdge系で開いてください。');return;}
      try{
        const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:12,max:24}},audio:false});
        screenStream=stream;
        screenPanel.hidden=false;
        screenVideo.srcObject=stream;
        await screenVideo.play().catch(()=>{});
        setScreenControls(true);
        screenToggle.textContent='■ 画面共有停止';
        screenToggle.classList.add('active');
        screenHint.textContent='共有中。操作案内が必要な発言では自動で画面を確認します。';
        const track=stream.getVideoTracks()[0];
        if(track)track.addEventListener('ended',stopCapture,{once:true});
      }catch(error){
        if(error&&error.name==='NotAllowedError')screenHint.textContent='画面共有がキャンセルされました。';
        else screenHint.textContent='画面共有を開始できませんでした。';
      }
    }

    function stopCapture(){
      if(screenStream){for(const track of screenStream.getTracks())track.stop();}
      screenStream=null;
      screenVideo.srcObject=null;
      manualMode=false;
      screenWrap.classList.remove('manual');
      manualButton.classList.remove('active');
      manualButton.textContent='手動矢印';
      setScreenControls(false);
      clearOverlay();
      screenToggle.textContent='▣ 画面共有';
      screenToggle.classList.remove('active');
      screenHint.textContent='画面共有を停止しました。';
    }

    function shouldLocate(text){
      return /(開きたい|開いて|開くには|押して|押す|クリック|タップ|どこ|探して|探す|見つけ|指して|矢印|案内|選んで|ボタン|アイコン|メニュー|タブ)/i.test(text);
    }

    async function locateOnScreen(query){
      if(!screenStream||locateBusy)return false;
      const q=(query||input.value).trim();
      if(!q){screenHint.textContent='何を探すか入力してください。';return false;}
      locateBusy=true;
      locateButton.disabled=true;
      screenHint.textContent='画面から対象を探しています…';
      try{
        const frame=captureFrame();
        const res=await fetch('/api/locate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q,image:frame.dataUrl})});
        const data=await res.json();
        if(!res.ok)throw new Error(data.error||'対象位置を取得できませんでした');
        if(!data.found){clearOverlay();screenHint.textContent=data.note||'対象を特定できませんでした。';return false;}
        drawArrow(data.x,data.y,data.label||'対象');
        screenHint.textContent='対象を矢印で示しました。';
        return true;
      }catch(error){
        clearOverlay();
        screenHint.textContent='位置特定エラー: '+error.message;
        return false;
      }finally{
        locateBusy=false;
        locateButton.disabled=!screenStream;
      }
    }

    screenToggle.addEventListener('click',()=>{if(screenStream)stopCapture();else startCapture()});
    locateButton.addEventListener('click',()=>locateOnScreen(input.value));
    clearOverlayButton.addEventListener('click',()=>{clearOverlay();screenHint.textContent='矢印を消しました。'});
    manualButton.addEventListener('click',()=>{
      if(!screenStream)return;
      manualMode=!manualMode;
      screenWrap.classList.toggle('manual',manualMode);
      manualButton.classList.toggle('active',manualMode);
      manualButton.textContent=manualMode?'手動矢印: ON':'手動矢印';
      screenHint.textContent=manualMode?'共有画面プレビュー上の指したい場所をクリックしてください。':'手動矢印を終了しました。';
    });
    screenWrap.addEventListener('click',(event)=>{
      if(!manualMode||!screenStream)return;
      const rect=screenWrap.getBoundingClientRect();
      drawArrow((event.clientX-rect.left)/rect.width*1000,(event.clientY-rect.top)/rect.height*1000,'手動指定');
      screenHint.textContent='指定した位置へ矢印を表示しました。';
    });
    shotButton.addEventListener('click',()=>{
      try{
        const frame=captureFrame(1920,0.9);
        const a=document.createElement('a');
        a.href=frame.dataUrl;
        a.download='talksys-screen-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jpg';
        document.body.appendChild(a);a.click();a.remove();
        screenHint.textContent='画面キャプチャーを保存しました。';
      }catch(error){screenHint.textContent=error.message;}
    });

    if(Recognition){
      recognition=new Recognition();
      recognition.lang='ja-JP';
      recognition.continuous=false;
      recognition.interimResults=false;
      recognition.maxAlternatives=1;
      recognition.onstart=()=>{listening=true;voiceSession=true;voice.classList.add('active');voice.textContent='■ 聞き取り停止';status.textContent='聞き取り中…'};
      recognition.onend=()=>{listening=false;voice.classList.remove('active');voice.textContent='🎙 音声で話す';if(status.textContent==='聞き取り中…')status.textContent=''};
      recognition.onerror=(event)=>{const ignored=event.error==='aborted'||event.error==='no-speech';if(!ignored)addMessage('assistant','音声入力を開始できませんでした。マイクの許可を確認してください。');status.textContent=''};
      recognition.onresult=(event)=>{const text=event.results?.[0]?.[0]?.transcript?.trim()||'';if(!text)return;input.value=text;submit()};
      voice.addEventListener('click',()=>{if(send.disabled)return;if(listening){recognition.stop();return;}if(canSpeak)window.speechSynthesis.cancel();try{recognition.start()}catch{status.textContent='音声入力を開始できませんでした'}});
    }else{voice.disabled=true;voice.textContent='音声入力非対応';voice.title='このブラウザーは音声認識に対応していません'}

    async function submit(){
      const text=input.value.trim();
      if(!text||send.disabled)return;
      if(listening)recognition.stop();
      messages.push({role:'user',content:text});
      addMessage('user',text);
      input.value='';
      send.disabled=true;
      voice.disabled=true;
      status.textContent='回答中…';
      if(screenStream&&shouldLocate(text))void locateOnScreen(text);
      try{
        const res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages})});
        const data=await res.json();
        if(!res.ok)throw new Error(data.error||'通信に失敗しました');
        messages.push({role:'assistant',content:data.reply});
        addMessage('assistant',data.reply);
        speak(data.reply);
      }catch(err){addMessage('assistant','エラー: '+err.message)}
      finally{send.disabled=false;voice.disabled=!Recognition;if(!voiceSession)status.textContent='';input.focus()}
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

function parseLocateResponse(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    if (!value || typeof value !== "object") return null;
    return {
      found: value.found === true,
      x: Math.max(0, Math.min(1000, Number(value.x) || 0)),
      y: Math.max(0, Math.min(1000, Number(value.y) || 0)),
      label: typeof value.label === "string" ? value.label.slice(0, 120) : "",
      note: typeof value.note === "string" ? value.note.slice(0, 240) : "",
    };
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, screenCapture: true, overlay: true });
    }

    if (request.method === "POST" && url.pathname === "/api/locate") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 500) : "";
      const image = typeof body.image === "string" ? body.image : "";
      if (!query) return json({ error: "query が必要です" }, 400);
      if (!/^data:image\/(jpeg|png);base64,/i.test(image)) return json({ error: "画像形式が不正です" }, 400);
      if (image.length > 2_000_000) return json({ error: "画像が大きすぎます" }, 413);

      const prompt = [
        "You are locating a user-interface target in a screenshot.",
        "The user said: " + query,
        "Find the single most useful visible UI element that the user should click or focus next.",
        "Coordinates must be relative to the entire screenshot, normalized from 0 to 1000: left=0, right=1000, top=0, bottom=1000.",
        "If no suitable target is clearly visible, set found to false.",
        "Return JSON only, with exactly these keys: found, x, y, label, note.",
        "Example: {\"found\":true,\"x\":820,\"y\":75,\"label\":\"Google Chrome icon\",\"note\":\"Click this icon.\"}",
      ].join("\n");

      try {
        const result = await env.AI.run(VISION_MODEL, {
          messages: [
            { role: "system", content: "Return only valid compact JSON. Do not use Markdown." },
            { role: "user", content: prompt },
          ],
          image,
          max_tokens: 180,
          temperature: 0.1,
        });
        const parsed = parseLocateResponse(result?.response);
        if (!parsed) return json({ error: "画面位置の解析結果を解釈できませんでした" }, 502);
        return json(parsed);
      } catch (error) {
        console.error(JSON.stringify({ event: "vision_error", message: String(error?.message || error) }));
        const message = String(error?.message || error);
        if (/agreement|5016|terms/i.test(message)) return json({ error: "Cloudflare上でVisionモデルの利用規約への同意が必要です" }, 503);
        return json({ error: "画面位置の解析に失敗しました" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }
      if (!Array.isArray(body.messages) || body.messages.length === 0) return json({ error: "messages が必要です" }, 400);
      const history = body.messages
        .slice(-12)
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (history.length === 0 || history[history.length - 1].role !== "user") return json({ error: "最後のメッセージは user である必要があります" }, 400);

      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: "あなたは簡潔で自然な会話をする日本語アシスタントです。画面共有中はUI操作を案内する場合がありますが、実際にクリックしたとは言わず、ユーザーが操作できるよう短く案内してください。必要に応じて他言語にも対応してください。" },
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
