export const devPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KAP+ development</title><style>
*{box-sizing:border-box}body{margin:0;background:#f8f9fa;color:#212529;font:14px system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px}header{display:flex;align-items:center;gap:16px;border-bottom:1px solid #d9dcdf;padding-bottom:16px}h1{font-size:20px;margin:0}button{font:inherit;background:white;color:inherit;border:1px solid #b7bdc3;border-radius:4px;padding:7px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible{outline:2px solid #212529;outline-offset:3px}#phase{margin-left:auto}dl{display:grid;grid-template-columns:120px 1fr;gap:8px 16px}dt{color:#626970}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#fff;padding:16px;border:1px solid #d9dcdf;line-height:1.6}#error{border-left:3px solid #a33;color:#792222}#canvas{max-width:100%;height:auto;display:block;border:1px solid #d9dcdf;background:white}iframe{width:100%;height:700px;border:1px solid #d9dcdf;background:white}footer{margin-top:24px;color:#626970;line-height:1.6}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}#notice{min-height:24px}code{font-family:monospace}@media(max-width:600px){main{padding:16px}header{flex-wrap:wrap}dl{grid-template-columns:90px 1fr}}
</style></head><body><main>
<header><h1 id="name">KAP+ development</h1><span id="phase" role="status">Starting</span></header>
<dl><dt>Preview</dt><dd id="mode"></dd><dt>Build</dt><dd id="build">Waiting</dd><dt>Runtime</dt><dd id="runtime">Waiting</dd></dl>
<div class="actions"><button data-action="rebuild">Rebuild</button><button id="restart" data-action="restart" disabled>Restart</button><button id="focus" data-action="focus" disabled>Open Khan window</button><button id="snapshot" disabled>Update snapshot</button></div>
<p id="notice" role="status"></p><pre id="error" role="alert" hidden></pre>
<img id="canvas" alt="Snapshot from the actual Khan preview canvas" hidden><iframe id="local" title="Local compatibility preview" hidden></iframe>
<footer id="explanation"></footer></main><script>
var lastBuild='';
function display(state){
 document.getElementById('name').textContent=state.name||'KAP+ development';
 document.getElementById('phase').textContent=state.phase;
 document.getElementById('mode').textContent=state.mode==='khan'?'Khan Academy sandbox':'Local ProcessingJS compatibility mode';
 document.getElementById('build').textContent=state.buildId?state.buildId+' / '+state.inputCount+' input files / '+state.buildMs+' ms':'Waiting for a successful build';
 document.getElementById('runtime').textContent=state.runtime?state.runtime.origin+' / '+(state.runtime.version||'version unavailable'):'Not connected';
 var error=document.getElementById('error');error.hidden=!state.error;error.textContent=state.error||'';
 document.getElementById('restart').disabled=state.phase!=='ready';
 document.getElementById('focus').disabled=state.mode!=='khan'||!state.runtime;
 document.getElementById('snapshot').disabled=state.mode!=='khan'||state.phase!=='ready';
 document.getElementById('explanation').textContent=state.mode==='khan'?'The interactive program runs in the Khan Academy window. This snapshot comes from its real canvas. Module and asset edits rebuild automatically; compilation errors retain the last successful preview.':'Compatibility mode uses local ProcessingJS and can differ from Khan. Use the default Khan mode for publication parity.';
 if(state.phase==='ready'&&state.buildId!==lastBuild){lastBuild=state.buildId;if(state.mode==='local'){var local=document.getElementById('local');local.hidden=false;local.src='/local/?build='+state.buildId;}else{snapshot();}}
}
function snapshot(){var img=document.getElementById('canvas');img.hidden=false;img.src='/api/canvas.png?t='+Date.now();}
document.getElementById('snapshot').onclick=snapshot;
document.querySelectorAll('[data-action]').forEach(function(button){button.onclick=async function(){try{var response=await fetch('/api/'+button.dataset.action,{method:'POST'});if(!response.ok)throw new Error(await response.text());document.getElementById('notice').textContent='';}catch(error){document.getElementById('notice').textContent=error.message;}};});
fetch('/api/status').then(function(response){return response.json();}).then(display);
var events=new EventSource('/events');events.onmessage=function(event){display(JSON.parse(event.data));};events.onerror=function(){document.getElementById('notice').textContent='Development server disconnected. Reconnecting…';};events.onopen=function(){document.getElementById('notice').textContent='';};
</script></body></html>`;
