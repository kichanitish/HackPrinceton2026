import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../dist/server/index.js';
test('built Worker serves the page and catalog without leaking server credentials',async()=>{
 const env={MATTERPORT_API_KEY:'server-only-key',MATTERPORT_API_TOKEN:'server-only-secret',VEXCEL_API_KEY:'server-only-vexcel',MATTERPORT_SDK_KEY:'browser-sdk-key'};
 const response=await worker.fetch(new Request('https://homefit.test/'),env);
 assert.equal(response.status,200);const html=await response.text();
 assert.match(html,/<title>HomeFit/);assert.ok(!html.includes('server-only'));assert.ok(!html.includes('browser-sdk-key'));
 const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
 assert.doesNotThrow(()=>new Function(script));
 assert.ok(!script.includes('/*__DOMAIN__*/'));
 const catalog=await (await worker.fetch(new Request('https://homefit.test/api/catalog'),env)).json();assert.equal(catalog.stats.plans,1700);
 const config=await (await worker.fetch(new Request('https://homefit.test/api/config'),env)).json();assert.equal(config.sdkKey,'browser-sdk-key');assert.ok(!JSON.stringify(config).includes('server-only'));
});
test('backend only permits catalog model ids and same-origin POST checks',async()=>{
 assert.equal((await worker.fetch(new Request('https://homefit.test/api/model?id=untrusted'),{})).status,400);
 assert.equal((await worker.fetch(new Request('https://homefit.test/api/check'),{})).status,405);
 assert.equal((await worker.fetch(new Request('https://homefit.test/api/check',{method:'POST',headers:{origin:'https://other.test'}}),{})).status,403);
 const response=await worker.fetch(new Request('https://homefit.test/api/check',{method:'POST'}),{});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.checks[0].state,'Ready');
 assert.equal(body.checks.find(x=>x.name==='Matterport GraphQL').state,'Not configured');
});
test('standalone preview embeds real catalog data and syntactically valid client code',async()=>{
 const html=await readFile(new URL('../HomeFit.html',import.meta.url),'utf8');
 assert.match(html,/window.HOMEFIT_CATALOG=/);
 assert.doesNotThrow(()=>new Function(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]));
});
