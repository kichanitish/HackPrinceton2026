// A connected SDK remains connected when optional metadata or tour discovery fails.
export async function inspectConnectedSdk(connected,{modelId,withTimeout,onUpdate,isCurrent=()=>true}){
 const initial={connected:true,modelId,label:modelId,guidedState:'checking',stopCount:0};
 if(isCurrent())onUpdate(initial);
 const [metadata,tour]=await Promise.allSettled([
  Promise.resolve().then(()=>withTimeout(connected.Model.getData(),8000)),
  Promise.resolve().then(()=>withTimeout(connected.Tour.getData(),8000))
 ]);
 const next={...initial,label:metadata.status==='fulfilled'?(metadata.value?.name||modelId):modelId};
 if(tour.status==='fulfilled'&&Array.isArray(tour.value)){
  next.stopCount=tour.value.length;next.guidedState=next.stopCount?'ready':'empty';
 }else next.guidedState='failed';
 if(isCurrent())onUpdate(next);
 return next;
}
export function sweepForRoom(room,sweeps){
 if(!room?.center||!room.bounds)return null;
 const {min,max}=room.bounds;
 return sweeps.filter(s=>s.enabled&&s.position&&(!room.floorInfo?.id||s.floorInfo?.id===room.floorInfo.id)&&['x','z'].every(k=>s.position[k]>=min[k]-.08&&s.position[k]<=max[k]+.08))
  .sort((a,b)=>['x','y','z'].reduce((n,k)=>n+(a.position[k]-room.center[k])**2-(b.position[k]-room.center[k])**2,0))[0]||null;
}
export function normalizeRoomName(label){return String(label||'').toLowerCase().replace(/\s+/g,' ').trim()}
export function matchingRoom(rooms,label){const found=rooms.filter(r=>normalizeRoomName(r.label)===normalizeRoomName(label));return found.length===1?found[0]:null}
