/*__API__*/
const PAGE = "__PAGE__";
const CATALOG = "__CATALOG__";
const modelIds=new Set(CATALOG.properties.flatMap(p=>p.plans.flatMap(plan=>plan.tours.map(t=>t.id))));
let cachedCheck=null,checkTime=0,pendingCheck=null;
const coverageCache=new Map(),modelCache=new Map(),imageCache=new Map();let coverageAudit=null,auditJob=null;const imageVerified=new Set();
async function coverageFor(env,p){if(!coverageCache.has(p.id)){const result=await propertyCoverage(env,p);if(result.ok)coverageCache.set(p.id,result);else return result}return coverageCache.get(p.id)}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:JSON_HEADERS})}
function auditResponse(result,url){
 if(url.searchParams.get('view')!=='html')return json(result);
 return new Response('<!doctype html><title>Catalog imagery coverage</title><h1>Catalog imagery coverage</h1><p>Covered coordinates: '+result.covered+' of '+result.total+'</p><p>Unverified coordinates: '+result.unverified+'</p><p>Properties with successful image retrieval: '+result.imageVerifiedPropertyIds.length+'</p>'+result.cities.map(c=>'<section><h2>'+c.city+'</h2><p>'+c.covered+' covered of '+c.total+'; '+c.unverified+' unverified.</p>'+(c.collections||[]).map(x=>'<p>'+x.id+' · '+x.layer+' · '+x.firstCapture+' to '+x.lastCapture+'</p>').join('')+'</section>').join('')+'<p>'+result.method+'</p>',{headers:{'content-type':'text/html; charset=utf-8'}});
}
function modelResponse(result,url){
 if(url.searchParams.get('view')!=='html')return json(result,result.ok?200:502);
 const esc=x=>String(x??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 return new Response('<!doctype html><title>Measured scan details</title><h1>Measured scan details</h1><p>'+esc(JSON.stringify({ok:result.ok,state:result.state,dimensionsState:result.dimensionsState,dimensions:result.model?.dimensions}))+'</p>'+(result.model?.rooms||[]).map(r=>'<h2>'+esc(r.label||r.id)+'</h2><p>'+esc(JSON.stringify(r.dimensions||null))+'</p>').join(''),{headers:{'content-type':'text/html; charset=utf-8'}});
}
export default {async fetch(request,env={}){
 const url=new URL(request.url);
 if(url.pathname.startsWith('/bundle/'))return env.ASSETS?env.ASSETS.fetch(request):json({error:'Bundle assets are not configured on this host'},404);
 if(url.pathname==='/api/catalog')return new Response(JSON.stringify(CATALOG),{headers:{...JSON_HEADERS,'cache-control':'private, max-age=3600'}});
 if(url.pathname==='/api/config')return json({googleMapsEmbedKey:env.GOOGLE_MAPS_EMBED_KEY||null,sdkKey:env.MATTERPORT_SDK_KEY||null,matterportConfigured:!!(env.MATTERPORT_API_KEY&&env.MATTERPORT_API_TOKEN),vexcelConfigured:!!env.VEXCEL_API_KEY});
 if(url.pathname==='/api/discovery'){
  const result=await vexcelDiscover(env);
  if(!result.ok)return json(result,502);
  const name=url.searchParams.get('tool');
  if(url.searchParams.get('view')==='html'){
   const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   const list=name?result.tools.filter(t=>t.name===name):result.tools;
   return new Response('<!doctype html><title>Vexcel API capabilities</title><h1>Vexcel API capabilities</h1>'+list.map(t=>'<section><h2>'+esc(t.name)+'</h2><p>'+esc(t.description?.slice(0,name?3000:400))+'</p>'+ (name?Object.entries(t.inputSchema?.properties||{}).map(([key,val])=>'<h3>'+esc(key)+(t.inputSchema.required?.includes(key)?' (required)':'')+'</h3><p>'+esc(JSON.stringify(val))+'</p>').join(''):'')+'</section>').join(''),{headers:{'content-type':'text/html; charset=utf-8'}});
  }
  return json(name?{tool:result.tools.find(t=>t.name===name)||null}:{tools:result.tools.map(t=>({name:t.name,description:t.description?.slice(0,450)}))});
 }
 if(url.pathname==='/api/vexcel-debug'){
  const p=CATALOG.properties.find(x=>x.id===Number(url.searchParams.get('id')));if(!p)return json({error:'Unknown property'},400);
  const result=await vexcelRpc(env,'ortho_imagery_collections',{wkt:'POINT('+p.lng+' '+p.lat+')',srid:4326,include:['layer','collection','first-capture-date','last-capture-date','min-gsd','max-zoom','pretty-name','geometry'],'page-size':20});
  const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  return new Response('<!doctype html><title>Vexcel sample coverage</title><h1>'+esc(p.name)+'</h1><h2>Result</h2><p>'+esc(JSON.stringify({ok:result.ok,state:result.state,keys:Object.keys(result.data||{})}))+'</p>'+Object.entries(result.data||{}).map(([k,v])=>'<h2>'+esc(k)+'</h2><p>'+esc(JSON.stringify(v).slice(0,5000))+'</p>').join(''),{headers:{'content-type':'text/html'}});
 }
 if(url.pathname==='/api/coverage-audit'){
  if(!coverageAudit){if(!auditJob)auditJob=catalogCoverage(env,CATALOG.properties).then(r=>{if(r.ok)coverageAudit=r;return r}).finally(()=>auditJob=null);const result=await auditJob;return auditResponse({...result,imageVerifiedPropertyIds:[...imageVerified]},url);}
  return auditResponse({...coverageAudit,imageVerifiedPropertyIds:[...imageVerified]},url);
 }
 if(url.pathname==='/api/coverage'){
  const p=CATALOG.properties.find(x=>x.id===Number(url.searchParams.get('id')));if(!p)return json({error:'Unknown property'},400);
  return json(await coverageFor(env,p));
 }
 if(url.pathname==='/api/aerial'){
  const p=CATALOG.properties.find(x=>x.id===Number(url.searchParams.get('id')));if(!p)return json({error:'Unknown property'},400);
  const coverage=await coverageFor(env,p);if(!coverage.ok)return json(coverage,502);
  const chosen=url.searchParams.get('collection');const collection=coverage.collections.find(c=>c.id===chosen)||(!chosen?coverage.collections[0]:null);if(!collection)return json({ok:false,state:'Collection unavailable'},404);
  const context=url.searchParams.get('context')==='1',cacheKey=p.id+':'+collection.id+':'+context;
  if(imageCache.has(cacheKey)){imageVerified.add(p.id);const cached=imageCache.get(cacheKey);return new Response(cached.bytes,{headers:{'content-type':cached.mimeType,'cache-control':'private, max-age=3600'}})}
  const result=await extractAerial(env,p,collection,context);if(!result.ok)return json(result,502);
  const payload=imagePayload(result);if(!payload||!['image/jpeg','image/png'].includes(payload.mimeType))return json({ok:false,state:'Image unavailable'},502);
  try{const bytes=Uint8Array.from(atob(payload.data),c=>c.charCodeAt(0));if(bytes.length<100)return json({ok:false,state:'Invalid image'},502);if(imageCache.size>=12)imageCache.delete(imageCache.keys().next().value);imageCache.set(cacheKey,{bytes,mimeType:payload.mimeType});imageVerified.add(p.id);return new Response(bytes,{headers:{'content-type':payload.mimeType,'cache-control':'private, max-age=3600'}})}catch{return json({ok:false,state:'Invalid image'},502)}
 }
 if(url.pathname==='/api/check'){
  if(request.method!=='POST')return json({error:'Use POST'},405);
  const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return json({error:'Invalid origin'},403);
  if(!cachedCheck||Date.now()-checkTime>300000){
   if(!pendingCheck)pendingCheck=checkCapabilities(env,'QAVsUEviwyK').then(result=>{cachedCheck=result;checkTime=Date.now();return result}).finally(()=>pendingCheck=null);
   await pendingCheck;
  }
  return json({checkedAt:cachedCheck.checkedAt,checks:[{name:'CoStar catalog',ok:true,state:'Ready',detail:CATALOG.stats.properties+' properties and '+CATALOG.stats.plans+' floor plans from November 12, 2026.'},...cachedCheck.checks,{name:'Matterport SDK',ok:false,state:env.MATTERPORT_SDK_KEY?'Check in tour':'Not configured',detail:'SDK domain and model access are verified when a tour connects in your browser.'}]});
 }
 if(url.pathname==='/api/model'){
  const id=url.searchParams.get('id');if(!modelIds.has(id))return json({error:'Unknown catalog model'},400);
  if(modelCache.has(id))return modelResponse(modelCache.get(id),url);
  const result=await modelDetails(env,id);if(result.ok){if(modelCache.size>=100)modelCache.delete(modelCache.keys().next().value);modelCache.set(id,result)}
  return modelResponse(result,url);
 }
 if(url.pathname==='/health')return json({ok:true,catalog:CATALOG.stats});
 if(url.pathname!=='/')return json({error:'Not found'},404);
 return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','permissions-policy':'camera=(), microphone=()','cache-control':'no-store'}});
}};
