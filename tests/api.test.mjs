import test from 'node:test';
import assert from 'node:assert/strict';
import {graph,decodeRpc,vexcelCheck,checkCapabilities,modelDetails,vexcelRpc} from '../worker/api.mjs';
const env={MATTERPORT_API_KEY:'test-key',MATTERPORT_API_TOKEN:'test-secret',VEXCEL_API_KEY:'test-vexcel'};
test('missing keys do not initiate network requests',async()=>{
 const fetcher=()=>{throw Error('must not call')};
 assert.equal((await graph({},'query{}',{},fetcher)).state,'Not configured');
 assert.equal((await vexcelCheck({},fetcher)).state,'Not configured');
});
test('upstream error bodies and secrets never reach clients',async()=>{
 const denied=await graph(env,'query{}',{},async()=>new Response('test-secret',{status:401}));
 assert.equal(denied.state,'Access denied');assert.ok(!JSON.stringify(denied).includes('test-secret'));
 const network=await graph(env,'query{}',{},async()=>{throw Error('test-secret')});
 assert.equal(network.state,'Connection failed');assert.ok(!JSON.stringify(network).includes('test-secret'));
});
test('GraphQL HTTP 200 with errors is not treated as success',async()=>{
 const result=await graph(env,'query{}',{},async()=>Response.json({errors:[{message:'secret details',extensions:{code:'request.unauthorized'}}]}));
 assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('secret details'));
});
test('null models and absent measurements are not reported as accessible',async()=>{
 const result=await checkCapabilities(env,'abc',async(url,options)=>{
  if(url.includes('vexcel'))return Response.json({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}});
  const query=JSON.parse(options.body).query;
  return Response.json({data:query.includes('models(')?{models:{totalResults:5,results:[]}}:{model:null}});
 });
 assert.equal(result.checks[0].ok,true);assert.equal(result.checks[1].ok,false);assert.equal(result.checks[2].ok,false);
 assert.equal(result.checks[3].ok,true);assert.match(result.checks[3].detail,/still need verification/);
});
test('MCP JSON and event-stream responses are both decoded',()=>{
 assert.equal(decodeRpc('{"result":{"ok":true}}').result.ok,true);
 assert.equal(decodeRpc('event: message\ndata: {"result":{"ok":true}}\n\n').result.ok,true);
 assert.equal(decodeRpc('bad response'),null);
});
test('room metadata survives a dimensional entitlement failure',async()=>{
 const result=await modelDetails(env,'abc',async(url,options)=>{
  const query=JSON.parse(options.body).query;
  return query.includes('areaFloorIndoor')?Response.json({errors:[{extensions:{code:'request.unauthorized'}}]}):Response.json({data:{model:{id:'abc',rooms:[{id:'room',label:'Kitchen'}],floors:[]}}});
 });
 assert.equal(result.ok,true);assert.equal(result.model.rooms[0].label,'Kitchen');assert.equal(result.dimensionsAvailable,false);
});
test('MCP product errors are distinct from successful authentication and expose no raw errors',async()=>{
 const result=await vexcelRpc(env,'ortho_extract',{},async(url,options)=>JSON.parse(options.body).method==='initialize'?Response.json({result:{protocolVersion:'2025-03-26'}}):Response.json({result:{isError:true,content:[{type:'text',text:'test-vexcel'}]}}));
 assert.equal(result.ok,false);assert.equal(result.state,'Product unavailable');assert.ok(!JSON.stringify(result).includes('test-vexcel'));
});
