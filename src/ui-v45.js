export const UI_REVISION = 'talksys-v55-experiment-chat-copy-20261001';

export const TALK_HTML_V45 = `<!doctype html>
<html lang="ja" data-ui-revision="${UI_REVISION}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>TalkSys</title>
  <style>
    :root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#eef1f6}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#edf1f7 0,#f7f8fa 38%,#eef1f6 100%)}button,input{font:inherit}
    .app{max-width:1480px;min-height:100dvh;margin:0 auto;background:#fff;box-shadow:0 0 0 1px rgba(17,24,39,.04),0 18px 60px rgba(15,23,42,.08)}
    .top{position:sticky;top:0;z-index:20;padding:14px 18px;background:rgba(255,255,255,.95);backdrop-filter:blur(14px);border-bottom:1px solid #e6e9ef;display:flex;align-items:center;gap:12px}
    .brand{font-size:21px;font-weight:900;letter-spacing:-.02em}.mode{font-size:12px;color:#667085;margin-top:2px}.status{margin-left:auto;font-size:13px;font-weight:800;color:#344054}
    .hero{padding:13px 18px;border-bottom:1px solid #edf0f4;background:#fafbfc}.hero-title{font-weight:850;font-size:14px}.hero-copy{margin-top:5px;color:#667085;font-size:12px;line-height:1.55}
    .chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:750}.chip strong{color:#1d2939}.dot{width:7px;height:7px;border-radius:50%;background:#12b76a}.dot.wait{background:#f79009}
    .workspace{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(380px,.75fr);min-height:calc(100dvh - 150px)}
    .conversation{min-width:0;display:flex;flex-direction:column;border-right:1px solid #e7eaf0;background:#fff}
    .chat{flex:1;min-height:560px;max-height:calc(100dvh - 320px);overflow:auto;padding:20px;display:flex;flex-direction:column;gap:10px;background:#fff}.msg{max-width:86%;padding:11px 14px;border-radius:15px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere}.user{align-self:flex-end;background:#172033;color:#fff;border-bottom-right-radius:5px}.assistant{align-self:flex-start;background:#f2f4f7;color:#1d2939;border-bottom-left-radius:5px}
    .controls{padding:14px 18px 16px;border-top:1px solid #e7eaf0;background:#fff}.mic{width:100%;border:0;border-radius:13px;padding:14px 16px;background:#172033;color:#fff;font-weight:850;cursor:pointer;min-height:52px}.mic.on{background:#b42318}.mic:focus-visible,.send:focus-visible,.test:focus-visible,input:focus-visible{outline:3px solid rgba(47,128,237,.25);outline-offset:2px}
    .form{display:flex;gap:8px;margin-top:10px}.input{flex:1;min-width:0;border:1px solid #d0d5dd;border-radius:11px;padding:11px 12px;font-size:16px}.send{border:1px solid #172033;background:#fff;color:#172033;border-radius:11px;padding:0 16px;font-weight:800;cursor:pointer}.hint{margin:8px 2px 0;color:#667085;font-size:11px;line-height:1.5}
    .debug{min-width:0;background:#fbfcfd;padding:16px 18px 18px;overflow:auto;max-height:calc(100dvh - 72px);position:sticky;top:62px;align-self:start}.debug-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.debug-title{font-size:14px;font-weight:900}.debug-copy{margin-top:3px;color:#667085;font-size:11px;line-height:1.45}.runtime{font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;padding:7px 9px;border:1px solid #d0d5dd;background:#fff;border-radius:9px;white-space:nowrap}.grid{display:grid;grid-template-columns:150px 1fr;gap:5px 10px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.key{color:#667085}.log{margin-top:10px;min-height:300px;max-height:calc(100dvh - 390px);overflow:auto;background:#101828;color:#d0d5dd;border-radius:10px;padding:10px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.test{margin-top:10px;border:1px solid #d0d5dd;background:#fff;border-radius:9px;padding:8px 10px;font-weight:750;cursor:pointer}.copy{margin-top:10px;border:1px solid #172033;background:#fff;color:#172033;border-radius:9px;padding:9px 12px;font-weight:800;cursor:pointer}.copy:focus-visible{outline:3px solid rgba(47,128,237,.25);outline-offset:2px}
    @media(max-width:960px){.app{max-width:none;box-shadow:none}.workspace{grid-template-columns:1fr}.conversation{border-right:0}.chat{min-height:420px;max-height:none}.debug{position:static;max-height:none;border-top:1px solid #e7eaf0}.log{max-height:300px}.top{padding:12px}.brand{font-size:18px}.hero{padding:12px}.chat{padding:12px}.msg{max-width:94%}.controls{padding:12px}.grid{grid-template-columns:112px 1fr}.status{font-size:12px}}
  </style>
</head>
<body>
<!-- deployment compatibility marker: talksys-v45-ui-restored-20260911 -->
<main class="app">
  <header class="top">
    <div><div class="brand">TalkSys</div><div class="mode">実験用チャット / 音声・検索検証</div></div>
    <div id="status" class="status" aria-live="polite">停止中</div>
  </header>
  <section class="hero">
    <div class="hero-title">TalkSys 実験用チャット</div>
    <div class="hero-copy">回答・検索・音声・割込み動作を確認するための検証画面です。会話内容は下のボタンから1つのテキストとしてまとめてコピーできます。</div>
    <div class="chips">
      <span class="chip"><span class="dot"></span><strong>音声</strong> HTTP + 適応VAD</span>
      <span class="chip"><span class="dot"></span><strong>回答</strong> evidence-first router</span>
      <span class="chip"><span class="dot"></span><strong>Runtime</strong> <span id="runtime-revision">読込中</span></span>
      <span class="chip"><span class="dot"></span><strong>Model</strong> <span id="model-name">gemini-3.5-flash-lite</span></span>
      <span id="phone-provider" class="chip"><span class="dot wait"></span><strong>Foonz</strong> 電話網連携確認中</span>
    </div>
  </section>
  <section class="workspace">
    <div class="conversation">
      <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">実験を開始できます。マイクでも文字入力でも同じTalkSys回答経路を検証します。</div></section>
      <section class="controls">
        <button id="mic" class="mic" type="button">マイク会話を開始</button>
        <form id="form" class="form"><input id="input" class="input" autocomplete="off" placeholder="実験用の文字入力" aria-label="実験用の文字入力"><button class="send" type="submit">送信</button></form>
        <button id="copy-chat" class="copy" type="button">会話をまとめてコピー</button>
        <div class="hint">左は実験用チャット、右は常時デバッグ表示です。同じ通話内の文脈は引き継ぎます。</div>
      </section>
    </div>
    <aside id="debug-pane" class="debug" aria-label="デバッグ情報">
      <div class="debug-head"><div><div class="debug-title">デバッグ</div><div class="debug-copy">ルート・検索・音声状態を会話と並べて確認します。</div></div><div class="runtime">UI ${UI_REVISION}</div></div>
      <div id="diag" class="grid"></div>
      <button id="tts-test" class="test" type="button">日本語TTSをテスト</button>
      <div id="log" class="log"></div>
    </aside>
  </section>
</main>
<script src="/talk-v45.js"></script>
<script>
(function(){
  var copy=document.getElementById('copy-chat');
  if(copy)copy.addEventListener('click',async function(){
    var chat=document.getElementById('chat');
    var rows=chat?Array.from(chat.querySelectorAll('.msg')).map(function(el){
      var who=el.classList.contains('user')?'利用者':'TalkSys';
      return who+': '+String(el.innerText||'').trim();
    }).filter(Boolean):[];
    var value=rows.join('\n\n').trim();
    if(!value){copy.textContent='コピー対象なし';setTimeout(function(){copy.textContent='会話をまとめてコピー';},1400);return;}
    try{
      await navigator.clipboard.writeText(value);
      copy.textContent='コピーしました';
    }catch(e){
      copy.textContent='コピー失敗';
    }
    setTimeout(function(){copy.textContent='会話をまとめてコピー';},1400);
  });
  var runtime=document.getElementById('runtime-revision');
  var model=document.getElementById('model-name');
  fetch('/gemini-health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(runtime&&d&&d.responseQualityRevision)runtime.textContent=d.responseQualityRevision;
    if(model&&d&&d.model)model.textContent=d.model;
  }).catch(function(){if(runtime)runtime.textContent='取得失敗';});
  fetch('/telephony-health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    var n=document.getElementById('phone-provider');if(!n)return;
    if(d&&d.connected===true){n.innerHTML='<span class="dot"></span><strong>Foonz</strong> 接続済み';}
    else{n.innerHTML='<span class="dot wait"></span><strong>Foonz</strong> 電話網連携確認中';}
  }).catch(function(){});
})();
</script>
</body>
</html>`;
