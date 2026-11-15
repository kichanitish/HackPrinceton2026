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
test('personal matching and the 2D planner are removed; Bundle assets use the host binding',async()=>{
 const html=await (await worker.fetch(new Request('https://homefit.test/'))).text();
 assert.ok(!html.includes('MAKE IT PERSONAL'));assert.ok(!html.includes('needsDialog'));assert.ok(!html.includes('plannerCanvas'));
 assert.ok(html.includes('Furnish in 3D'));assert.ok(html.includes('mp.transformControls'));
 const url='https://homefit.test/bundle/version.txt';
 assert.equal((await worker.fetch(new Request(url))).status,404);
 const asset=await worker.fetch(new Request(url),{ASSETS:{fetch:request=>new Response(new URL(request.url).pathname)}});
 assert.equal(await asset.text(),'/bundle/version.txt');
});

test('only the website-restricted Google embed key is exposed through browser configuration',async()=>{
 const env={GOOGLE_MAPS_EMBED_KEY:'public-embed-key',MATTERPORT_API_TOKEN:'private-token',VEXCEL_API_KEY:'private-vexcel'};
 const config=await (await worker.fetch(new Request('https://homefit.test/api/config'),env)).json();
 assert.equal(config.googleMapsEmbedKey,'public-embed-key');assert.ok(!JSON.stringify(config).includes('private-'));
 const missing=await (await worker.fetch(new Request('https://homefit.test/api/config'),{})).json();assert.equal(missing.googleMapsEmbedKey,null);
});
test('recommendation API requires same-origin JSON POST and keeps the model credential server-only',async()=>{
 const base='https://homefit.test/api/recommend',env={OPENROUTER_API_KEY:'server-model-secret'};
 assert.equal((await worker.fetch(new Request(base),env)).status,405);
 assert.equal((await worker.fetch(new Request(base,{method:'POST',headers:{origin:'https://other.test','content-type':'application/json'},body:'{}'}),env)).status,403);
 assert.equal((await worker.fetch(new Request(base,{method:'POST',body:'{}'}),env)).status,415);
 const unavailable=await worker.fetch(new Request(base,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{});assert.equal(unavailable.status,503);
 const invalid=await worker.fetch(new Request(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({city:'Unknown'})}),env);assert.equal(invalid.status,400);
 const config=await (await worker.fetch(new Request('https://homefit.test/api/config'),env)).json();assert.equal(config.recommendationsConfigured,true);assert.ok(!JSON.stringify(config).includes('server-model-secret'));
});
