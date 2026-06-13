const r = await fetch('http://127.0.0.1:9222/json');
const targets = await r.json();
const page = targets.find(t => t.type === 'page' && /stress/.test(t.url)) || targets.find(t=>t.webSocketDebuggerUrl);
if(!page){console.log('no page');process.exit(0);}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const send=(m,p)=>ws.send(JSON.stringify({id:++id,method:m,params:p}));
ws.addEventListener('open',()=>{ send('Runtime.evaluate',{expression:`(()=>{const c=document.createElement('canvas');const gl=c.getContext('webgl');const dbg=gl&&gl.getExtension('WEBGL_debug_renderer_info');return JSON.stringify({renderer:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'?',vendor:dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):'?'});})()`,returnByValue:true}); });
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id===1){console.log('GL:',m.result&&m.result.result&&m.result.result.value); ws.close(); process.exit(0);}});
setTimeout(()=>process.exit(0),5000);
