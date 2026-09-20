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
const readJson = require('./nbread.cjs');   // the service may be mid-write
const { seed } = await import('./fixtures.mjs');
const [A, B] = seed(FIX, 'struct45.ipynb', 'struct44.ipynb');
fs.rmSync(FIX + '/.web-chat/jpy-history', { recursive: true, force: true });

const store = {}; let onEv = null;
const ctx = { name:'jpy-notebook', mountId:'m', params:{ notebooks:[A,B] }, webChatDir:FIX + '/.web-chat',
  log:()=>{}, fence:(p,c)=>c, diff:()=>null,
  driver:{ setStore(p){Object.assign(store,p);return Promise.resolve({ok:true})},
    getStore(k){const o={};for(const x of k||[])if(x in store)o[x]=store[x];return Promise.resolve(o)},
    streamEvents({onEvent}){onEv=onEvent;return{close(){}}} } };
let sq=0; const next=()=>(sq=Math.max(Date.now(),sq+1));
const ctl=(op,extra)=>{const patch={jpy_ctl:{seq:next(),op,...(extra||{})}};Object.assign(store,patch);if(onEv)onEv({patch})};
const until=async(p,w,ms=25000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(p())return;await new Promise(r=>setTimeout(r,100))}throw new Error('timeout '+w)};
const settle=()=>new Promise(r=>setTimeout(r,350));
let fails=0; const ok=(l,c,e)=>{if(!c)fails++;console.log((c?'  PASS  ':'  FAIL  ')+l+(e!==undefined?'  -> '+String(e).slice(0,120):''))};
const tab=(i)=>store.jpy_nb.tabs[i];

await svc.start(ctx);
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect');
ok('connected', store.jpy_conn.ok===true, store.jpy_conn.error);

console.log('\n— insert —');
const ids0 = tab(0).cells.map(c=>c.id);
ctl('insert',{cell:'a1', where:'after', type:'code'}); await settle();
const ids1 = tab(0).cells.map(c=>c.id);
ok('a cell appeared', ids1.length===ids0.length+1, ids1.join(','));
ok('inserted in the right place', ids1[0]==='a1' && ids1[2]==='a2', ids1.join(','));
const newId = ids1[1];
ok('new cell id is fresh and well-formed', /^u[0-9a-f]{8}$/.test(newId), newId);

console.log('\n— edit the NEW cell and the one after it, then save —');
ctl('edit',{cell:newId, source:'inserted = 42'}); await settle();
ctl('edit',{cell:'a2', source:'second = 222'}); await settle();
ctl('save',{}); await until(()=>store.jpy_save && store.jpy_save.state!=='saving','save');
ok('saved', store.jpy_save.state==='saved', store.jpy_save.state+': '+(store.jpy_save.error||''));

const after = readJson(A);
ok('file has three cells', after.cells.length===3, after.cells.length);
ok('ORDER is right (this is what index-based mapping got wrong)', after.cells.map(c=>String(c.source).replace(/,/g,'')).join(' | ').includes('first = 1'), after.cells.map(c=>c.source).join(' | '));
ok('inserted cell holds ITS text', String(after.cells[1].source).includes('inserted = 42'), after.cells[1].source);
ok('the cell after it holds ITS text, not the neighbour’s', String(after.cells[2].source).includes('second = 222'), after.cells[2].source);
ok('untouched cell keeps its metadata', JSON.stringify(after.cells[2].metadata).includes('keep'), JSON.stringify(after.cells[2].metadata));
ok('untouched cell keeps its outputs', (after.cells[2].outputs||[]).length===1, (after.cells[2].outputs||[]).length);
ok('4.5: the new cell got an id', typeof after.cells[1].id==='string' && after.cells[1].id.length>0, after.cells[1].id);
ok('and it MATCHES the id the model uses', after.cells[1].id===newId, after.cells[1].id+' vs model '+newId);
ok('new code cell is nbformat-valid', after.cells[1].execution_count===null && Array.isArray(after.cells[1].outputs));

console.log('\n— delete —');
ctl('delete',{cell:'a1'}); await settle();
ctl('save',{}); await until(()=>store.jpy_save && store.jpy_save.state!=='saving','save2');
const afterDel = readJson(A);
ok('cell removed from the file', afterDel.cells.length===2, afterDel.cells.length);
ok('the right one went', !JSON.stringify(afterDel.cells).includes('first = 1'));
ok('deleted cell’s output key tombstoned', store.jpy_out_a1===null, JSON.stringify(store.jpy_out_a1));

console.log('\n— 4.4 notebook must NOT gain ids —');
ctl('set-tab',{id:'t1'}); await settle();
ctl('insert',{cell:null, where:'after', type:'markdown'}); await settle();
ctl('save',{}); await until(()=>store.jpy_save && store.jpy_save.state!=='saving','save3');
const b = readJson(B);
ok('4.4 saved', store.jpy_save.state==='saved', store.jpy_save.state+': '+(store.jpy_save.error||''));
ok('4.4 gained a cell', b.cells.length===3, b.cells.length);
ok('NO id leaked into the 4.4 file', !b.cells.some(c=>'id' in c), JSON.stringify(b.cells.map(c=>Object.keys(c))));
ok('nbformat_minor still 4', b.nbformat_minor===4, b.nbformat_minor);
ok('new markdown cell has no execution_count/outputs', !('execution_count' in b.cells[2]) && !('outputs' in b.cells[2]), JSON.stringify(Object.keys(b.cells[2])));

await stopSvc();
console.log('\n'+(fails?fails+' FAILING':'all green'));
process.exit(fails?1:0);
