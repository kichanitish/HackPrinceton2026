export function matchModelProviders(env){
 const providers=[];
 if(env.OPENAI_API_KEY)providers.push({provider:'openai',model:env.OPENAI_MODEL||env.AGENT_MODEL_OPENAI||'gpt-5.5'});
 if(env.OPENROUTER_API_KEY)providers.push({provider:'openrouter',model:env.OPENROUTER_MODEL||'openrouter/free'});
 return providers;
}
export async function invokeMatchModel(env,{tools,options={},messages,signal,callbacks,onEvent=()=>{},phase,validate}){
 const providers=matchModelProviders(env);if(!providers.length)throw new Error('No model configured');
 let lastError,lastResponse;
 for(let i=0;i<providers.length;i++){
  if(signal?.aborted)throw signal.reason;
  const spec=providers[i],timeoutMs=phase==='preferences'?(providers.length===1?28000:i===0?18000:12000):(providers.length===1?14000:i===0?9000:5000);
  const callSignal=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)].filter(Boolean));
  onEvent('model.provider',{phase,...spec,attempt:i+1});
  try{
   let model;
   if(spec.provider==='openai'){
    const {ChatOpenAI}=await import('@langchain/openai');
    model=new ChatOpenAI({model:spec.model,apiKey:env.OPENAI_API_KEY,useResponsesApi:true,maxTokens:2200,maxRetries:0,...(/^gpt-5|^o[134]/.test(spec.model)?{reasoning:{effort:'low'}}:{})});
   }else{const {ChatOpenRouter}=await import('@langchain/openrouter');model=new ChatOpenRouter({model:spec.model,apiKey:env.OPENROUTER_API_KEY,maxTokens:2200,maxRetries:0,temperature:0,siteName:'Scout',provider:{require_parameters:true}})}
   const response=await model.bindTools(tools,options).invoke(messages,{signal:callSignal,callbacks});lastResponse=response;
   if(!validate||validate(response)){onEvent('model.provider_completed',{phase,...spec});return response}
   onEvent('model.provider_fallback',{phase,...spec,reason:'invalid_structured_output'});
  }catch(error){lastError=error;if(signal?.aborted)throw error;onEvent('model.provider_fallback',{phase,...spec,reason:callSignal.aborted?'timeout':'provider_error',status:error?.status??error?.statusCode??null})}
 }
 if(lastResponse)return lastResponse;
 throw lastError||new Error('Model unavailable');
}
