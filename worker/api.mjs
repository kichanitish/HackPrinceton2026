// Read-only provider integrations. Never return credentials or raw upstream errors.
export const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
export async function graph(env,query,variables={},fetcher=fetch){
 if(!env.MATTERPORT_API_KEY||!env.MATTERPORT_API_TOKEN)return {ok:false,state:'Not configured',detail:'Matterport server credentials have not been configured.'};
 try{
  const r=await fetcher('https://api.matterport.com/api/models/graph',{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+btoa(env.MATTERPORT_API_KEY+':'+env.MATTERPORT_API_TOKEN)},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)return {ok:false,state:r.status===401||r.status===403?'Access denied':'Provider error',detail:'Matterport returned HTTP '+r.status+'.',httpStatus:r.status};
  const body=await r.json();
  if(body.errors?.length){const code=body.errors[0]?.extensions?.code;return {ok:false,state:'Not available',detail:code==='request.unauthorized'?'This key cannot access the requested model or field.':'The requested query or model is unavailable for this account.',httpStatus:r.status};}
  return {ok:true,data:body.data,httpStatus:r.status};
 }catch{return {ok:false,state:'Connection failed',detail:'The server could not reach Matterport. Credential validity is unverified.'};}
}
export function decodeRpc(text){
 try{return JSON.parse(text)}catch{}
 for(const line of text.split('\n').reverse())if(line.startsWith('data:')){try{return JSON.parse(line.slice(5).trim())}catch{}}
 return null;
}
export async function vexcelDiscover(env,fetcher=fetch){
 if(!env.VEXCEL_API_KEY)return {ok:false,state:'Not configured'};
 try{
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','X-API-KEY':env.VEXCEL_API_KEY};
  const init=await fetcher('https://api.vexcelgroup.com/v2/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'scout',version:'1.1.0'}}}),signal:AbortSignal.timeout(20000)});
  if(!init.ok)return {ok:false,state:'Discovery failed',httpStatus:init.status};
  const initialized=decodeRpc(await init.text());if(!initialized?.result)return {ok:false,state:'Invalid discovery response'};
  const session=init.headers.get('mcp-session-id');if(session)headers['mcp-session-id']=session;
  headers['mcp-protocol-version']=initialized.result.protocolVersion||'2025-03-26';
  const response=await fetcher('https://api.vexcelgroup.com/v2/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}),signal:AbortSignal.timeout(20000)});
  const rpc=decodeRpc(await response.text());
  if(!response.ok||!rpc?.result?.tools)return {ok:false,state:'Tools unavailable',httpStatus:response.status};
  return {ok:true,tools:rpc.result.tools};
 }catch{return {ok:false,state:'Connection failed'}}
}
export async function modelDetails(env,id,fetcher=fetch){
 const base=await graph(env,'query ($id:ID!){model(id:$id){id name rooms{id label} floors{id label}}}',{id},fetcher);
 if(!base.ok||!base.data?.model)return {...base,ok:false};
 const dimensions=await graph(env,'query ($id:ID!){model(id:$id){dimensions{areaFloorIndoor units} rooms{id dimensions{areaFloorIndoor width depth height units}}}}',{id},fetcher);
 const model=base.data.model;
 model.rooms=Array.isArray(model.rooms)?model.rooms:[];
 model.floors=Array.isArray(model.floors)?model.floors:[];
 if((model.rooms||[]).some(r=>!r.label)){
  const classes=await graph(env,'query ($id:ID!){model(id:$id){rooms{id classifications{label}}}}',{id},fetcher);
  if(classes.ok){const labels=new Map((classes.data?.model?.rooms||[]).map(r=>[r.id,r.classifications?.[0]?.label]));model.rooms=model.rooms.map(r=>({...r,label:r.label||labels.get(r.id)||null}));}
 }
 if(dimensions.ok&&dimensions.data?.model){
  model.dimensions=dimensions.data.model.dimensions;
  const byId=new Map((dimensions.data.model.rooms||[]).map(r=>[r.id,r.dimensions]));
  model.rooms=model.rooms.map(r=>({...r,dimensions:byId.get(r.id)||null}));
 }
 if(!model.dimensions){const area=await graph(env,'query ($id:ID!){model(id:$id){dimensions{areaFloorIndoor units}}}',{id},fetcher);if(area.ok)model.dimensions=area.data?.model?.dimensions||null;}
 return {ok:true,model,dimensionsAvailable:model.dimensions?.areaFloorIndoor>0,dimensionsState:dimensions.ok?'Loaded':dimensions.state};
}
export async function vexcelRpc(env,name,args,fetcher=fetch){
 if(!env.VEXCEL_API_KEY)return {ok:false,state:'Not configured'};
 try{
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','X-API-KEY':env.VEXCEL_API_KEY};
  const init=await fetcher('https://api.vexcelgroup.com/v2/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'scout',version:'1.1.0'}}}),signal:AbortSignal.timeout(20000)});
  const initialized=decodeRpc(await init.text());if(!init.ok||!initialized?.result)return {ok:false,state:'Authentication failed',httpStatus:init.status};
  const session=init.headers.get('mcp-session-id');if(session)headers['mcp-session-id']=session;
  headers['mcp-protocol-version']=initialized.result.protocolVersion||'2025-03-26';
  const r=await fetcher('https://api.vexcelgroup.com/v2/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(40000)});
  const body=decodeRpc(await r.text());if(!r.ok||body?.error||body?.result?.isError)return {ok:false,state:r.status===401||r.status===403?'Access denied':'Product unavailable',httpStatus:r.status};
  const result=body?.result;if(!result)return {ok:false,state:'Invalid response'};
  if(result.structuredContent)return {ok:true,data:result.structuredContent};
  for(const c of result.content||[])if(c.type==='text'){try{return {ok:true,data:JSON.parse(c.text)}}catch{}}
  const image=(result.content||[]).find(c=>c.type==='image');if(image)return {ok:true,image:{data:image.data,mimeType:image.mimeType}};
  return {ok:false,state:'No usable data'};
 }catch{return {ok:false,state:'Connection failed'}}
}
export async function vexcelCheck(env,fetcher=fetch){
 if(!env.VEXCEL_API_KEY)return {name:'Vexcel API',ok:false,state:'Not configured',detail:'Vexcel credentials have not been configured.'};
 try{
  const r=await fetcher('https://api.vexcelgroup.com/v2/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','X-API-KEY':env.VEXCEL_API_KEY},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'scout-access-check',version:'1.0.0'}}}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)return {name:'Vexcel API',ok:false,state:r.status===401||r.status===403?'Access denied':'Check incomplete',detail:'Vexcel MCP returned HTTP '+r.status+'. Imagery permissions remain unverified.'};
  const body=decodeRpc(await r.text());if(!body?.result)return {name:'Vexcel API',ok:false,state:'Check incomplete',detail:'The Vexcel discovery service did not complete initialization. Imagery permissions remain unverified.'};
  return {name:'Vexcel API',ok:true,state:'Connected',detail:'Vexcel MCP authentication succeeded. Product-specific imagery and structure access still need verification.'};
 }catch{return {name:'Vexcel API',ok:false,state:'Connection failed',detail:'The server could not reach Vexcel. Credential validity and imagery permissions are unverified.'};}
}
export async function checkCapabilities(env,sampleId,fetcher=fetch){
 const [account,model,dimensions,vexcel]=await Promise.all([
  graph(env,'query { models(query:"*",pageSize:1){ totalResults results{id} } }',{},fetcher),
  graph(env,'query ($id:ID!){ model(id:$id){id name rooms{id label} floors{id label}} }',{id:sampleId},fetcher),
  graph(env,'query ($id:ID!){ model(id:$id){dimensions{areaFloorIndoor units}} }',{id:sampleId},fetcher),
  vexcelCheck(env,fetcher)
 ]);
 if(account.ok&&!account.data?.models)Object.assign(account,{ok:false,state:'Not available',detail:'The account query returned no model collection.'});
 if(model.ok&&!model.data?.model)Object.assign(model,{ok:false,state:'Not available',detail:'The sample kit model is not accessible to this account.'});
 if(dimensions.ok&&dimensions.data?.model?.dimensions?.areaFloorIndoor==null)Object.assign(dimensions,{ok:false,state:'Not available',detail:'The sample model returned no indoor floor-area measurement.'});
 const row=(name,result,detail)=>({name,ok:result.ok,state:result.ok?'Connected':result.state,detail:result.ok?detail:result.detail});
 return {checkedAt:new Date().toISOString(),sampleModelId:sampleId,checks:[
  row('Matterport GraphQL',account,'Account query succeeded; '+(account.data?.models?.totalResults??'unknown')+' models reported.'),
  row('Kit model access',model,'Sample model '+sampleId+' is readable; '+(model.data?.model?.rooms?.length??0)+' room records returned.'),
  row('Room dimensions',dimensions,dimensions.data?.model?.dimensions?.areaFloorIndoor!=null?'Sample-model indoor floor area is available.':'Query succeeded, but the sample model has no recorded indoor floor area.'),
  vexcel
 ]};
}
