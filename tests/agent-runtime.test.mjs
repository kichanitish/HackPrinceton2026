import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendProperties} from '../worker/recommendations.mjs';
import {runMatchAgent} from '../worker/recommend-agent.mjs';
let installed=true;try{await import('@langchain/openrouter');await import('langchain')}catch{installed=false}
test('the installed LangChain/OpenRouter adapter handles a token-exhausted ranking without an incomplete result',{skip:!installed},async()=>{
 const originalFetch=globalThis.fetch,requests=[],events=[];
 const interpretation={scope:'housing',issue:'none',filters:{city:null,budget:null,beds:null,baths:null,maxBeds:null,minSqft:null,dogs:false,cats:false,parking:false,zipCodes:[],priority:'space'},location:{query:'LAX',radiusMiles:10,mode:'straight_line'}};
 globalThis.fetch=async(address,options)=>{
  assert.equal(new URL(address).hostname,'openrouter.ai');const body=JSON.parse(options.body);requests.push(body);
  const first=requests.length===1;assert.equal(body.tool_choice.function.name,first?'analyze_preferences':'finish_shortlist');
  return new Response(JSON.stringify({id:'mock-'+requests.length,model:'test-model',object:'chat.completion',created:1,choices:[{index:0,finish_reason:first?'tool_calls':'length',message:first?{role:'assistant',content:null,tool_calls:[{id:'call-analysis',type:'function',function:{name:'analyze_preferences',arguments:JSON.stringify(interpretation)}}]}:{role:'assistant',content:''}}],usage:{prompt_tokens:100,completion_tokens:first?300:900,total_tokens:first?400:1000}}),{headers:{'content-type':'application/json'}});
 };
 try{
  const properties=[1,2,3,4].map(id=>({id,name:'Building '+id,city:'Los Angeles',lat:33.95,lng:-118.4,pets:[],parking:[],plans:[{id:id*10,name:'A1',rentMin:2000,beds:0,baths:1,sqftMin:800+id*100,available:1,tours:[{id:'scan'+id}]}]}));
  const result=await recommendProperties(properties,{city:'Los Angeles',budget:3000,beds:0,needs:'More space within 10 miles of LAX'},{runAgent:args=>runMatchAgent({OPENROUTER_API_KEY:'server-only-test-key'},{...args,onEvent:(event,data)=>events.push({event,data})})});
  assert.equal(requests.length,2);assert.equal(requests[1].max_tokens,900);assert.equal(result.matches.length,3);assert.equal(result.selectionMethod,'validated_filters');assert.deepEqual(result.matches.map(m=>m.propertyId),[4,3,2]);
  assert.equal(events.find(x=>x.event==='model.step'&&x.data.finishReason==='length').data.outputTokens,900);assert.ok(events.some(x=>x.event==='selection.fallback'));assert.ok(!JSON.stringify(events).includes('server-only-test-key'));
 }finally{globalThis.fetch=originalFetch}
});
test('partial and string-valued preferences pass through the real adapter and preserve all hard filters',{skip:!installed},async()=>{
 const originalFetch=globalThis.fetch;let count=0;
 globalThis.fetch=async()=>{
  count++;const name=count===1?'analyze_preferences':'finish_shortlist',args=count===1?{scope:'housing',filters:{budget:'3000',beds:'0',priority:'space'},location:{query:'LAX',radiusMiles:'10'}}:{selections:[4,3,2].map(id=>({propertyId:id,planId:id*10,strengthKeys:['area'],tradeoffKey:'space'}))};
  return Response.json({id:'partial',model:'test',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-'+count,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300}});
 };
 try{
  const properties=[1,2,3,4].map(id=>({id,name:'Building '+id,city:'Los Angeles',lat:33.95,lng:-118.4,pets:[],parking:[],plans:[{id:id*10,name:'A1',rentMin:2000,beds:0,baths:1,sqftMin:800+id*100,available:1,tours:[{id:'scan'+id}]}]}));
  const result=await recommendProperties(properties,{city:'Los Angeles',budget:3000,beds:0,needs:'More space within 10 miles of LAX'},{runAgent:args=>runMatchAgent({OPENROUTER_API_KEY:'dummy'},{...args})});
  assert.equal(count,2);assert.equal(result.matches.length,3);assert.equal(result.criteria.budget,3000);assert.equal(result.criteria.radiusMiles,10);assert.equal(result.criteria.beds,0);
 }finally{globalThis.fetch=originalFetch}
});
test('uninterpretable preferences produce clarification and stop before catalog ranking',{skip:!installed},async()=>{
 const originalFetch=globalThis.fetch,events=[];let count=0;
 globalThis.fetch=async()=>{count++;return Response.json({id:'invalid',model:'test',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'bad',type:'function',function:{name:'analyze_preferences',arguments:JSON.stringify({scope:'housing',filters:{budget:'secret-invalid-value'}})}}]}}]})};
 try{
  const result=await recommendProperties([],{city:'Los Angeles',needs:'A rental'},{runAgent:args=>runMatchAgent({OPENROUTER_API_KEY:'dummy'},{...args,onEvent:(event,data)=>events.push({event,data})})});
  assert.equal(count,1);assert.equal(result.status,'clarification');assert.equal(result.code,'uninterpretable_preferences');assert.deepEqual(result.matches,[]);assert.ok(events.some(e=>e.event==='preferences.invalid'));assert.ok(!JSON.stringify(events).includes('secret-invalid-value'));
 }finally{globalThis.fetch=originalFetch}
});
