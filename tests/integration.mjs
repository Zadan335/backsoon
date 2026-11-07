// Integration against the challenge's local sandbox. Usage:
// HARNESS_PATH=/absolute/path/to/harness/server.js node tests/integration.mjs
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const harnessPath=process.env.HARNESS_PATH;
if(!harnessPath){console.error('Set HARNESS_PATH to the challenge harness/server.js');process.exit(1);}
const dir=mkdtempSync(join(tmpdir(),'backsoon-test-'));
const hport=42121,aport=42122,base=`http://127.0.0.1:${hport}`,app=`http://127.0.0.1:${aport}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let h,a,log='';
const run=(args,env)=>{const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);return p;};
async function ready(url){for(let i=0;i<100;i++){try{let r=await fetch(url);if(r.ok)return}catch{}await sleep(100)}throw Error(`Did not start: ${url}\n${log}`);}
async function post(url,data,headers={}){return fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});}
async function form(url,data){return fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),redirect:'manual'});}
async function until(fn,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(200)}throw Error('Timed out waiting for condition');}
function localDb(){return new DatabaseSync(join(dir,'app','alerts.sqlite'));}
try {
 h=run([harnessPath],{PORT:String(hport),PUBLIC_URL:base,DATA_DIR:join(dir,'harness'),SIM_INTERVAL_SECONDS:'3600',INVITE_CODE:'stock-e11d21'});
 await ready(base+'/healthz');
 let signup=await form(base+'/signup',{name:'Local integration test',invite:'stock-e11d21'});assert.equal(signup.status,303);let dash=signup.headers.get('location');assert.match(dash,/^\/c\//);
 let page=await (await fetch(base+dash)).text();let get=k=>{const m=page.match(new RegExp(k+'=([^\\s<]+)'));if(!m)throw Error('Missing '+k);return m[1]};
 let secret=get('WEBHOOK_SECRET'),key=get('STOCK_API_KEY'),emailKey=get('RESEND_API_KEY');
 await form(base+dash+'/sim',{action:'stop'});
 const env={PORT:String(aport),DATA_DIR:join(dir,'app'),STOCK_API_URL:base+'/api/stock',STOCK_API_KEY:key,RESEND_BASE_URL:base,RESEND_API_KEY:emailKey,WEBHOOK_SECRET:secret,ADMIN_PASSWORD:'local-test-password',NODE_NO_WARNINGS:'1'};
 const startApp=async()=>{a=run([resolve('server.mjs')],env);await ready(app+'/health');};
 await startApp();await form(base+dash+'/baseurl',{baseUrl:app});
 assert.equal((await fetch(app+'/embed')).status,200);
 assert.equal((await fetch(app+'/admin')).status,401);
 assert.equal((await fetch(app+'/admin',{headers:{authorization:'Basic '+Buffer.from('admin:local-test-password').toString('base64')}})).status,200);
 assert.equal((await post(app+'/api/requests',{email:'bad',sku:'AA'})).status,400);
 assert.equal((await post(app+'/api/requests',null)).status,400);
 assert.equal((await post(app+'/webhooks/stock',null,{'x-webhook-secret':secret})).status,400);
 const sku='MUG-STN-SAGE';await form(base+dash+'/stock',{sku,quantity:'0'});
 const rs=await Promise.all(Array.from({length:20},()=>post(app+'/api/requests',{email:'person@example.com',sku})));
 assert(rs.every(r=>[200,201].includes(r.status)));
 let db=localDb();assert.equal(db.prepare('SELECT count(*) n FROM requests WHERE sku=?').get(sku).n,1);db.close();
 assert.equal((await post(app+'/webhooks/stock',{event_id:'bad-secret',sku,quantity:5},{'x-webhook-secret':'wrong'})).status,401);
 await post(base+'/api/test/phantom',{sku,quantity:5},{authorization:'Bearer '+key});
 await sleep(1600);let inbox=()=>{try{let d=JSON.parse(readFileSync(join(dir,'harness','db.json'),'utf8'));return Object.values(d.candidates)[0].emails}catch{return []}};
 assert.equal(inbox().filter(e=>e.status==='accepted').length,0,'phantom stock sent email');
 await form(base+dash+'/fail',{n:'1'});
 let action=await post(base+'/api/test/restock',{sku,quantity:6,event_id:'same-event',twice:true},{authorization:'Bearer '+key});assert(action.ok);
 await until(()=>inbox().some(e=>e.status==='accepted'));let emails=inbox();assert.equal(emails.filter(e=>e.status==='accepted').length,1);assert(emails.some(e=>e.status.startsWith('failed')),'injected failure not observed');
 assert.equal(new Set(emails.map(e=>e.idempotencyKey)).size,1);
 let same=await Promise.all(Array.from({length:8},()=>post(app+'/webhooks/stock',{event_id:'same-event',sku,quantity:6},{'x-webhook-secret':secret})));assert(same.every(r=>r.status===202));await sleep(1200);assert.equal(inbox().filter(e=>e.status==='accepted').length,1);
 db=localDb();let row=db.prepare('SELECT status,notified_at FROM requests WHERE sku=?').get(sku);assert.equal(row.status,'notified');assert(row.notified_at);db.close();
 const sku2='CAP-WAX-OLV';await form(base+dash+'/stock',{sku:sku2,quantity:'0'});assert.equal((await post(app+'/api/requests',{email:'restart@example.com',sku:sku2})).status,201);
 a.kill('SIGTERM');await new Promise(r=>a.once('exit',r));await startApp();
 action=await post(base+'/api/test/restock',{sku:sku2,quantity:8,event_id:'after-restart',twice:true},{authorization:'Bearer '+key});assert(action.ok);await until(()=>inbox().filter(e=>e.status==='accepted').length===2);
 db=localDb();assert.equal(db.prepare("SELECT count(*) n FROM requests WHERE status='notified'").get().n,2);assert.equal(db.prepare("SELECT count(*) n FROM events WHERE event_id='same-event'").get().n,1);db.close();
 const sku3='TEE-ORG-WHT-M';await form(base+dash+'/stock',{sku:sku3,quantity:'0'});await post(app+'/api/requests',{email:'retry-restart@example.com',sku:sku3});
 const beforeFailures=inbox().filter(e=>e.status.startsWith('failed')).length;
 await form(base+dash+'/fail',{n:'1'});await post(base+'/api/test/restock',{sku:sku3,quantity:5,event_id:'retry-restart-event',twice:true},{authorization:'Bearer '+key});
 await until(()=>inbox().filter(e=>e.status.startsWith('failed')).length>beforeFailures);
 a.kill('SIGTERM');await new Promise(r=>a.once('exit',r));await startApp();
 await until(()=>inbox().filter(e=>e.status==='accepted').length===3);
 db=localDb();assert.equal(db.prepare('SELECT status FROM requests WHERE sku=?').get(sku3).status,'notified');db.close();
 const sku4='BAG-LTH-TAN';await form(base+dash+'/stock',{sku:sku4,quantity:'3'});await post(app+'/api/requests',{email:'already-in-stock@example.com',sku:sku4});
 await until(()=>inbox().filter(e=>e.status==='accepted').length===4);
 db=localDb();assert.equal(db.prepare('SELECT status FROM requests WHERE sku=?').get(sku4).status,'notified');db.close();
 console.log('PASS: embed, admin auth, input validation, 20 concurrent duplicate requests, invalid secret, phantom stock, injected email retry, duplicate webhooks, pending job recovery on restart, in-stock signup, notification history');
} catch(e){console.error('FAIL:',e.stack,'\nProcess output:',log);process.exitCode=1;}
finally{if(a&&!a.killed)a.kill('SIGTERM');if(h&&!h.killed)h.kill('SIGTERM');await sleep(200);rmSync(dir,{recursive:true,force:true});}
