import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
// Release the kernel with the service, EVERY time — a harness that starts the
// service more than once starts a kernel each time, and pairing the two by hand
// meant tabs-harness (three starts, one release) leaked two per run.
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
// Fixture root — override with JPY_FIXTURES to run this anywhere.
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs');
const { seed } = await import('./fixtures.mjs');
const [NB] = seed(FIX, 'truncation.ipynb');
fs.rmSync(FIX + '/.web-chat/jpy-history', { recursive: true, force: true });
const before = fs.readFileSync(NB, 'utf8');

const store = {}; let onEv = null;
const ctx = { name:'jpy-notebook', mountId:'m', params:{ notebooks:[NB] }, webChatDir:FIX + '/.web-chat',
  log:()=>{}, fence:(p,c)=>c, diff:()=>null,
  driver:{ setStore(p){Object.assign(store,p);return Promise.resolve({ok:true})},
    getStore(k){const o={};for(const x of k||[])if(x in store)o[x]=store[x];return Promise.resolve(o)},
    streamEvents({onEvent}){onEv=onEvent;return{close(){}}} } };
let sq=0; const next=()=>(sq=Math.max(Date.now(),sq+1));
const ctl=(op,extra)=>{const patch={jpy_ctl:{seq:next(),op,...(extra||{})}};Object.assign(store,patch);if(onEv)onEv({patch})};
const until=async(p,w,ms=25000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(p())return;await new Promise(r=>setTimeout(r,120))}throw new Error('timeout '+w)};
let fails=0; const ok=(l,c,e)=>{if(!c)fails++;console.log((c?'  PASS  ':'  FAIL  ')+l+(e!==undefined?'  -> '+String(e).slice(0,150):''))};

await svc.start(ctx);
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect');
ok('connected', store.jpy_conn.ok===true, store.jpy_conn.error);

const tab = store.jpy_nb.tabs[0];
ok('tab with a truncated cell is marked NOT saveable', tab.saveable===false, 'saveable='+tab.saveable);
ok('and says why, naming the limit', /truncated|per-cell limit/.test(tab.save_hint||''), tab.save_hint);

console.log('\n— save must be refused —');
ctl('save', {});
await until(()=>store.jpy_save && store.jpy_save.state!=='saving','save verdict');
ok('save REFUSED', store.jpy_save.state==='unsaveable', store.jpy_save.state+': '+(store.jpy_save.error||''));
ok('the file on disk is byte-identical', fs.readFileSync(NB,'utf8')===before);

console.log('\n— run must be refused on the truncated cell —');
ctl('run', { cell:'huge' });
await until(()=>store.jpy_out_huge,'run verdict');
const o = (store.jpy_out_huge.outputs||[])[0]||{};
ok('run REFUSED with a named error', store.jpy_out_huge.state==='error' && o.ename==='TruncatedSource', o.ename);
ok('and explains it would run a prefix', /prefix of your code/.test(o.evalue||''), o.evalue);

console.log('\n— an intact neighbour still runs fine —');
ctl('run', { cell:'after1' });
await until(()=>store.jpy_out_after1 && ['ok','error'].includes(store.jpy_out_after1.state),'neighbour run');
ok('neighbour executes normally', store.jpy_out_after1.state==='ok', store.jpy_out_after1.state);

console.log('\n— run-all skips it instead of stalling —');
ctl('run-all', {});
await new Promise(r=>setTimeout(r,2500));
ok('run-all completed without wedging', store.jpy_out_after2 && ['ok','error'].includes(store.jpy_out_after2.state), store.jpy_out_after2 && store.jpy_out_after2.state);

await stopSvc();
console.log('\n'+(fails?fails+' FAILING':'all green — truncated notebooks are now read-only and unrunnable, not silently erased'));
process.exit(fails?1:0);
