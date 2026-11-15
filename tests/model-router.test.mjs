import test from 'node:test';
import assert from 'node:assert/strict';
import {tool} from 'langchain';
import {z} from 'zod';
import {matchModelProviders,invokeMatchModel} from '../worker/model-router.mjs';
const tools=[tool(async()=>({}),{name:'analyze_preferences',description:'Parse preferences',schema:z.object({scope:z.string()})})];
const config={tools,options:{tool_choice:'analyze_preferences'},messages:[{role:'user',content:'A rental'}],phase:'preferences',validate:r=>r.tool_calls?.[0]?.name==='analyze_preferences'};
function primary(){return Response.json({id:'resp_test',object:'response',status:'completed',created_at:1,model:'gpt-5.5',output:[{id:'fc_test',type:'function_call',call_id:'call_test',name:'analyze_preferences',arguments:'{"scope":"housing"}',status:'completed'}],usage:{input_tokens:10,output_tokens:10,total_tokens:20}})}
function fallback(){return Response.json({id:'chat_test',object:'chat.completion',model:'test',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'analyze_preferences',arguments:'{"scope":"housing"}'}}]}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}
const env={OPENAI_API_KEY:'primary-test-key',OPENROUTER_API_KEY:'fallback-test-key'};
test('OpenAI is preferred even if both providers or an Anthropic key are configured',async()=>{
 assert.equal(matchModelProviders({...env,ANTHROPIC_API_KEY:'ignored'})[0].provider,'openai');const original=fetch,requests=[];
 globalThis.fetch=async(address)=>{requests.push(String(address));return primary()};
 try{const result=await invokeMatchModel(env,config);assert.equal(requests.length,1);assert.match(requests[0],/^https:\/\/api.openai.com\/v1\/responses/);assert.equal(result.tool_calls[0].name,'analyze_preferences')}finally{globalThis.fetch=original}
});
test('a failed OpenAI request automatically falls back to OpenRouter without dropping tool constraints',async()=>{
 const original=fetch,requests=[],events=[];
 globalThis.fetch=async(address,options)=>{requests.push({url:String(address),body:JSON.parse(options.body)});return requests.length===1?Response.json({error:{message:'Test outage'}},{status:503}):fallback()};
 try{const result=await invokeMatchModel(env,{...config,onEvent:(event,data)=>events.push({event,data})});assert.equal(requests.length,2);assert.match(requests[1].url,/openrouter.ai/);assert.equal(requests[1].body.tool_choice.function.name,'analyze_preferences');assert.equal(result.tool_calls[0].args.scope,'housing');assert.ok(events.some(x=>x.event==='model.provider_fallback'))}finally{globalThis.fetch=original}
});
test('without an OpenAI key OpenRouter remains usable, and neither provider key is logged',async()=>{
 const original=fetch,events=[];globalThis.fetch=async()=>fallback();
 try{await invokeMatchModel({OPENROUTER_API_KEY:'secret-sentinel'},{...config,onEvent:(event,data)=>events.push({event,data})});assert.equal(events[0].data.provider,'openrouter');assert.ok(!JSON.stringify(events).includes('secret-sentinel'))}finally{globalThis.fetch=original}
});
