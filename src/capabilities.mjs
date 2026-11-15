// Feature flags are tri-state: undefined is not evidence of absence.
export function featureAvailability(value){return value===true?'available':value===false?'unavailable':'unverified'}
export function scanForPlan(plan,id){return plan.tours.find(t=>t.id===id)||plan.tours[0]}
export function availablePublishedViews(collection){
 return Object.values(collection||{}).filter(view=>view&&typeof view.id==='string'&&typeof view.setActive==='function');
}
export function defurnishPair(views){
 const empty=views.find(v=>v.type==='viewtype.defurnish');
 const furnished=views.find(v=>v.type==='viewtype.base')||views.find(v=>v.type==='viewtype.layeredbase')||views.find(v=>v.type!=='viewtype.defurnish');
 return empty&&furnished?{empty,furnished}:null;
}
export function observePlaying(connected,{timeoutMs=20000,isCurrent=()=>true}={}){
 if(!connected.App?.state?.subscribe)return Promise.resolve(false);
 return new Promise(resolve=>{
  let subscription,settled=false;
  const done=value=>{if(settled)return;settled=true;clearTimeout(timer);subscription?.cancel?.();resolve(value)};
  const timer=setTimeout(()=>done(false),timeoutMs);
  const changed=state=>{if(!isCurrent())done(false);else if(state.phase==='appphase.playing')done(true);else if(state.phase==='appphase.error')done(false)};
  try{subscription=connected.App.state.subscribe(changed);if(settled)subscription?.cancel?.()}catch{done(false)}
 });
}
export async function scanDisplaySettings(connected){
 const keys=['measurements','dollhouse','floor_plan','defurnish_view','room_bounds','labels','tour_buttons'];
 if(!connected.Settings?.get)return {};
 const values=await Promise.allSettled(keys.map(key=>connected.Settings.get(key)));
 return Object.fromEntries(values.flatMap((value,index)=>value.status==='fulfilled'&&typeof value.value==='boolean'?[[keys[index],value.value]]:[]));
}

// Compare only linked scans of the same floor plan; never substitute another layout.
export function bestExposedScan(tours,results){
 const positive=value=>Number.isFinite(value)&&value>0;
 const rank=result=>{
  if(!result?.ok||!result.model)return [0,0,0,0,0,0];
  const model=result.model,rooms=(model.rooms||[]).filter(r=>String(r.label||'').toLowerCase()!=='void');
  const measured=rooms.filter(r=>['metric','imperial'].includes(r.dimensions?.units)&&(positive(r.dimensions.areaFloorIndoor)||(positive(r.dimensions.width)&&positive(r.dimensions.depth))));
  const area=['metric','imperial'].includes(model.dimensions?.units)&&positive(model.dimensions.areaFloorIndoor);
  const fields=measured.reduce((n,r)=>n+['areaFloorIndoor','width','depth','height'].filter(k=>positive(r.dimensions[k])).length,0);
  return [Number(measured.length>0),measured.length,Number(area),fields,1,rooms.length];
 };
 let best=0;
 for(let i=1;i<tours.length;i++){
  const a=rank(results[i]),b=rank(results[best]);
  for(let j=0;j<a.length;j++){if(a[j]===b[j])continue;if(a[j]>b[j])best=i;break}
 }
 return tours[best];
}
