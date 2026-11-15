import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScoutHandler} from '../scripts/server.mjs';

async function request(handler,{url='/',method='GET',headers={},body}={}){
 const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{url,method,headers:{host:'scout.example',...headers},socket:{}});
 const res=new EventEmitter();res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;res.headersSent=true};res.end=body=>{res.body=body?Buffer.from(body).toString():'';res.writableEnded=true};
 await handler(req,res);return res;
}
test('production proxy handling preserves the public HTTPS origin for same-origin agent requests',async()=>{
 let received;
 const handler=createScoutHandler({bundleRoot:'/unused',env:{TRUST_PROXY:'1'},worker:{fetch:async req=>{received=req;return new Response('ok')}}});
 const res=await request(handler,{url:'/api/recommend',method:'POST',headers:{origin:'https://scout.example','x-forwarded-proto':'https','content-type':'application/json'},body:'{}'});
 assert.equal(res.status,200);assert.equal(received.url,'https://scout.example/api/recommend');assert.equal(received.headers.get('origin'),new URL(received.url).origin);
});
test('health checks avoid provider calls, large inputs are rejected, and absolute external URLs are not dispatched',async()=>{
 let calls=0;const handler=createScoutHandler({bundleRoot:'/unused',worker:{fetch:async()=>{calls++;return new Response('ok')}}});
 assert.equal((await request(handler,{url:'/healthz'})).status,200);assert.equal(calls,0);
 assert.equal((await request(handler,{url:'/api/recommend',method:'POST',body:'a'.repeat(4097)})).status,413);
 assert.equal((await request(handler,{url:'https://outside.example/api/catalog'})).status,400);assert.equal(calls,0);
});
test('production serves Bundle assets with MIME types and blocks traversal outside the SDK directory',async t=>{
 const root=await mkdtemp(join(tmpdir(),'scout-server-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bundleRoot=join(root,'bundle');await mkdir(bundleRoot);await writeFile(join(bundleRoot,'showcase.html'),'SDK page');await writeFile(join(root,'secret.txt'),'not served');
 const handler=createScoutHandler({bundleRoot,worker:{fetch:async()=>new Response('app')}});
 const good=await request(handler,{url:'/bundle/showcase.html'});assert.equal(good.status,200);assert.match(good.headers['content-type'],/text\/html/);assert.equal(good.body,'SDK page');
 const bad=await request(handler,{url:'/bundle/%2e%2e%2fsecret.txt'});assert.equal(bad.status,403);assert.ok(!bad.body.includes('not served'));
 assert.equal((await request(handler,{url:'/bundle/missing.js'})).status,404);
});
