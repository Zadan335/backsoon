// Simulate a provider accepting an email, then dropping the HTTP response.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const dir=mkdtempSync(join(tmpdir(),'backsoon-idem-')), port=42222,providerPort=42221;
const base=`http://127.0.0.1:${port}`;let calls=0,accepted=0;const keys=new Map();
const provider=http.createServer(async(req,res)=>{
 if(req.url==='/stock/TEST-SKU'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({quantity:7,in_stock:true}));}
 if(req.url==='/emails'&&req.method==='POST'){
   for await(const _ of req){};calls++;const key=req.headers['idempotency-key'];assert(key);
   if(!keys.has(key)){keys.set(key,'accepted-1');accepted++;req.socket.destroy();return;}
   res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:keys.get(key)}));
 }
 res.writeHead(404);res.end();
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let child;
try{
 await new Promise(r=>provider.listen(providerPort,'127.0.0.1',r));
 child=spawn(process.execPath,[resolve('server.mjs')],{env:{...process.env,PORT:String(port),DATA_DIR:dir,STOCK_API_URL:`http://127.0.0.1:${providerPort}/stock`,STOCK_API_KEY:'test',RESEND_BASE_URL:`http://127.0.0.1:${providerPort}`,RESEND_API_KEY:'test',WEBHOOK_SECRET:'test',ADMIN_PASSWORD:'test-password',NODE_NO_WARNINGS:'1'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await sleep(100);}
 const oversized=await fetch(base+'/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'sample@example.com',sku:'TEST-SKU',padding:'x'.repeat(17000)})});
 assert.equal(oversized.status,413);
 const response=await fetch(base+'/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'sample@example.com',sku:'TEST-SKU'})});assert.equal(response.status,201);
 let db=new DatabaseSync(join(dir,'alerts.sqlite'));let notified=false;
 for(let i=0;i<100;i++){if(db.prepare('SELECT status FROM requests').get()?.status==='notified'){notified=true;break;}await sleep(100);}
 assert(notified,'job was not retried successfully');assert(calls>=2);assert.equal(accepted,1);assert.equal(keys.size,1);db.close();
 console.log('PASS: accepted-then-disconnected email request retries with same idempotency key and records exactly one provider acceptance');
}catch(e){console.error(e.stack);process.exitCode=1;}
finally{child?.kill('SIGTERM');await new Promise(r=>provider.close(r));await sleep(100);rmSync(dir,{recursive:true,force:true});}
