// Keep ranking bounded. Once preferences are validated, a stalled model must not discard real matches.
export function compactMatchCandidates(rows){
 const seen=new Set();return rows.filter(row=>{if(seen.has(row.propertyId))return false;seen.add(row.propertyId);return true}).slice(0,12).map(row=>({
  propertyId:row.propertyId,planId:row.planId,name:row.name,rent:row.rentMin,beds:row.beds,baths:row.baths,sqft:row.area,
  distanceMiles:row.distanceMiles??null,evidenceKeys:Object.keys(row.evidence?.fit||{}),tradeoffKeys:Object.keys(row.evidence?.tradeoffs||{})
 }));
}
export function validatedMatchSelections(rows,criteria,input){
 const wantsFurniture=/\b(?:desk|desks|furniture|sofa|bed fit|office|work from home)\b/i.test(input.needs||'');
 return compactMatchCandidates(rows).slice(0,3).map(row=>{
  const available=new Set(row.evidenceKeys);const preferred=[criteria.priority==='space'?'area':criteria.priority==='distance'?'distance':'rent',criteria.dogs?'dog':criteria.cats?'cats':criteria.parking?'parking':criteria.mode==='commercial'?'use':'beds','area','rent'];
  return {propertyId:row.propertyId,planId:row.planId,strengthKeys:[...new Set(preferred)].filter(k=>available.has(k)).slice(0,2),tradeoffKey:criteria.mode==='commercial'?'business':wantsFurniture?'space':criteria.location?'distance':row.tradeoffKeys.includes('budget')?'budget':'fees'};
 });
}
export async function completeMatchRanking({tools,input,criteria,invokeSelection,signal,onEvent=()=>{}}){
 const found=await tools.search_properties({});const candidates=compactMatchCandidates(found.matches||[]),fallback=validatedMatchSelections(found.matches||[],criteria,input);
 if(!candidates.length){await tools.finish_shortlist({selections:[],selectionMethod:'validated_filters'});return}
 const scanData=await tools.inspect_scan_data({selections:fallback.map(({propertyId,planId})=>({propertyId,planId}))});
 for(const row of candidates){const scan=Array.isArray(scanData)?scanData.find(s=>s.propertyId===row.propertyId&&s.planId===row.planId):null;if(scan){row.measuredRooms=scan.measuredRooms;row.evidenceKeys=Object.keys(scan.evidence?.fit||{});row.tradeoffKeys=Object.keys(scan.evidence?.tradeoffs||{})}}
 if(candidates.length<=3){onEvent('selection.direct',{reason:'three_or_fewer_candidates'});await tools.finish_shortlist({selections:fallback,selectionMethod:'validated_filters'});return}
 try{
  const selection=await invokeSelection({input,criteria,candidates});
  await tools.finish_shortlist({...selection,selectionMethod:'model'});
 }catch(error){
  if(signal?.aborted)throw error;
  onEvent('selection.fallback',{reason:['no_tool_call','length','invalid_selection','ranking_timeout'].includes(error?.matchFailure)?error.matchFailure:'ranking_unavailable',candidateProperties:candidates.length});
  await tools.finish_shortlist({selections:fallback,selectionMethod:'validated_filters'});
 }
}
