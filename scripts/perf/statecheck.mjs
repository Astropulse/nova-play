const r = await fetch('http://127.0.0.1:9222/json');
const targets = await r.json();
const page = targets.find(t => t.type === 'page' && /stress/.test(t.url)) || targets.find(t=>t.webSocketDebuggerUrl);
if(!page){console.log('no page');process.exit(0);}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const send=(m,p)=>ws.send(JSON.stringify({id:++id,method:m,params:p}));
const expr = `(()=>{const g=window.__novaGame;const c=g&&g.canvas;return JSON.stringify({dpr:window.devicePixelRatio,inner:[window.innerWidth,window.innerHeight],canvas:c?[c.width,c.height]:null,gw:g&&g.width,gh:g&&g.height,worldScale:g&&g.worldScale,hudScale:g&&g.hudScale,lowPerf:g&&g.lowPerfMode,canvasCount:document.getElementsByTagName('canvas').length});})()`;
ws.addEventListener('open',()=>{ send('Runtime.evaluate',{expression:expr,returnByValue:true}); });
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id===1){console.log(m.result&&m.result.result&&m.result.result.value || JSON.stringify(m)); ws.close(); process.exit(0);}});
setTimeout(()=>process.exit(0),5000);
