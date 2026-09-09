import grounded from './worker-v43-reviewfix.js';

const REVISION='talksys-v43.1-smoke-grounded-adaptive-vad';
const OLD_REVISION='talksys-v43-smoke-weather-adaptive-vad';

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function clean(v,max=6000){return String(v??'').replace(/\s+/g,' ').trim().slice(0,max);}
function polishPcAdvice(answer){
  let v=clean(answer,5000);
  v=v.replace(/^(?:こんにちは[、。]?\s*)?(?:お電話ありがとうございます[。、]?\s*)?/,'').trim();
  v=v.replace(/^パソコンの購入をご検討中とのことですね[、。]?\s*/,'');
  return v||clean(answer,5000);
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&['/talk-v43.js','/talk-v42.js'].includes(url.pathname)){
      const r=await grounded.fetch(request,env,ctx),text=(await r.text()).replaceAll(OLD_REVISION,REVISION);
      const h=new Headers(r.headers);h.set('cache-control','no-store');h.set('x-talksys-revision',REVISION);return new Response(text,{status:r.status,headers:h});
    }
    if(request.method==='GET'&&url.pathname==='/'){
      const r=await grounded.fetch(request,env,ctx),text=(await r.text()).replaceAll(OLD_REVISION,REVISION);
      const h=new Headers(r.headers);h.set('cache-control','no-store');h.set('x-talksys-revision',REVISION);return new Response(text,{status:r.status,headers:h});
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      const r=await grounded.fetch(request,env,ctx),type=r.headers.get('content-type')||'';if(!type.includes('application/json'))return r;
      try{const d=await r.json();if(d?.ok&&d.route==='pc-advice-v43')d.answer=polishPcAdvice(d.answer);return json(d,r.status);}catch{return r;}
    }
    return grounded.fetch(request,env,ctx);
  }
};

export const __test={polishPcAdvice};
