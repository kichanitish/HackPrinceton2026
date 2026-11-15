import {commercialPlanMatches,commercialFitScore,commercialFacts} from './business.mjs';
import {distanceMiles,resolveMatchPlace,supportedCityForPlace} from './places.mjs';
import {matchReply,obviousMatchIssue,MATCH_REPLIES} from './match-policy.mjs';
// Catalog facts are authoritative. Models choose evidence keys, never UI prose.
export class MatchError extends Error{constructor(code){super(code);this.code=code}}
const validCities=['Houston','Los Angeles'];
export function normalizeMatchInput(input){
 if(!input||typeof input!=='object'||!validCities.includes(input.city))throw new MatchError('invalid');
 const numeric=(value,min,max)=>{if(value===''||value===null||value===undefined)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new MatchError('invalid');return value};
 const needs=typeof input.needs==='string'?input.needs.trim():'';if(needs.length>700)throw new MatchError('invalid');
 const beds=numeric(input.beds,0,6);if(beds!==null&&!Number.isInteger(beds))throw new MatchError('invalid');
 const locationChoiceId=typeof input.locationChoiceId==='string'&&input.locationChoiceId.length<=100?input.locationChoiceId:null;
 const radiusOverride=numeric(input.radiusOverride,.01,500);
 return {descriptionFirst:input.descriptionFirst===true,mode:input.mode==='commercial'?'commercial':'home',business:typeof input.business==='string'?input.business:null,minSqft:numeric(input.minSqft,50,1000000),maxSqft:numeric(input.maxSqft,50,1000000),locationChoiceId,radiusOverride,city:input.city,budget:numeric(input.budget,100,200000),beds,baths:numeric(input.baths,.5,6),dogs:input.dogs===true,needs};
}
export function matchCriteria(input,inferred={}){
 const number=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:null;
 return {city:input.city,budget:input.budget??number(inferred.budget,100,200000),beds:input.beds??number(inferred.beds,0,6),baths:input.baths??number(inferred.baths,.5,6),dogs:input.dogs||inferred.dogs===true,parking:inferred.parking===true,priority:['rent','space','distance'].includes(inferred.priority)?inferred.priority:'balanced',minSqft:number(inferred.minSqft,50,1000000),maxBeds:number(inferred.maxBeds,0,6),cats:inferred.cats===true,zipCodes:Array.isArray(inferred.zipCodes)?[...new Set(inferred.zipCodes.filter(x=>typeof x==='string'&&/^\d{5}$/.test(x)))].slice(0,12):[]};
}
export function findMatchCandidates(properties,criteria){
 const rows=[];
 for(const p of properties){
  if((p.mode||'home')!==(criteria.mode||'home'))continue;
  if(p.city!==criteria.city)continue;
  if(criteria.zipCodes?.length&&!criteria.zipCodes.includes(p.zip))continue;
  if(criteria.cats&&(p.noPets===true||!p.pets?.some(x=>x.type==='Cat')))continue;
  const miles=criteria.location?distanceMiles(p,criteria.location):null;
  if(criteria.location&&(miles===null||criteria.radiusMiles!==null&&miles>criteria.radiusMiles))continue;
  if(criteria.parking&&(p.noParking===true||!p.parking?.length))continue;
  const dog=p.pets?.find(x=>x.type==='Dog');if(criteria.dogs&&(p.noPets===true||!dog))continue;
  for(const plan of p.plans||[]){
   if(!(plan.available>0)||((criteria.mode||'home')==='home'&&!(plan.rentMin>0&&plan.tours?.length)))continue;
   if(criteria.mode==='commercial'&&!commercialPlanMatches(p,plan,criteria))continue;
   if(criteria.minSqft!==null&&criteria.minSqft!==undefined&&!(plan.sqftMin>=criteria.minSqft))continue;
   if(criteria.maxBeds!==null&&criteria.maxBeds!==undefined&&!(Number.isFinite(plan.beds)&&plan.beds<=criteria.maxBeds))continue;
   if(criteria.budget!==null&&(!(plan.rentMin>0)||plan.rentMin>criteria.budget))continue;
   if(criteria.mode!=='commercial'&&criteria.beds!==null&&(!Number.isFinite(plan.beds)||plan.beds<criteria.beds))continue;
   if(criteria.mode!=='commercial'&&criteria.baths!==null&&(!Number.isFinite(plan.baths)||plan.baths<criteria.baths))continue;
   rows.push({property:p,plan,distanceMiles:miles});
  }
 }
 // Consider several layouts per property, but bound context and avoid one building dominating.
 rows.sort((a,b)=>criteria.priority==='business'?commercialFitScore(b.property,b.plan,criteria)-commercialFitScore(a.property,a.plan,criteria)||(a.plan.rentMin??Infinity)-(b.plan.rentMin??Infinity):criteria.priority==='distance'&&criteria.location?a.distanceMiles-b.distanceMiles||(a.plan.rentMin??Infinity)-(b.plan.rentMin??Infinity):criteria.priority==='space'?(b.plan.sqftMin||0)-(a.plan.sqftMin||0)||(a.plan.rentMin??Infinity)-(b.plan.rentMin??Infinity):(a.plan.rentMin??Infinity)-(b.plan.rentMin??Infinity)||(b.plan.sqftMin||0)-(a.plan.sqftMin||0));
 const counts=new Map();return rows.filter(row=>{const count=counts.get(row.property.id)||0;counts.set(row.property.id,count+1);return count<2}).slice(0,24);
}
function summaryFacts(row,criteria,scan){
 const {property:p,plan}=row,dog=p.pets?.find(x=>x.type==='Dog'),money=n=>'$'+Number(n).toLocaleString('en-US');
 const fit={distance:criteria.location&&Number.isFinite(row.distanceMiles)?row.distanceMiles.toFixed(1)+' mi from '+criteria.location.name+' (straight-line)':null,cats:p.pets?.some(x=>x.type==='Cat')?'Pet friendly · cats listed':null,rent:money(plan.rentMin)+'/mo starting rent'+(criteria.budget!==null?' · within your '+money(criteria.budget)+' budget':''),beds:(plan.beds===0?'Studio':plan.beds+(plan.beds===1?' bedroom':' bedrooms'))+' · '+plan.baths+(plan.baths===1?' bathroom':' bathrooms'),area:plan.sqftMin>0?plan.sqftMin.toLocaleString('en-US')+' sq ft reported floor area':null,parking:p.parking?.length?'Parking listed: '+p.parking.map(x=>x.type).join(', '):null,dog:dog?'Pet friendly · dogs listed'+(dog.rent!=null?' · '+money(dog.rent)+'/pet/month':' · fees need confirmation'):null,scan:scan?.measuredRooms>0?scan.measuredRooms+(scan.measuredRooms===1?' room has scan measurements':' rooms have scan measurements'):null};
 const tradeoffs={distance:'Straight-line distance; driving miles and traffic are not verified.',cats:'Cat restrictions and total pet fees need confirmation.',parking:'Parking availability and charges need confirmation.',fees:'Mandatory fees and exact unit pricing still need confirmation.',budget:criteria.budget!==null&&plan.rentMax>criteria.budget?'Some units in this floor plan exceed your budget.':null,dog:dog?'Dog restrictions and total pet fees need confirmation.':null,space:'Furniture fit is unverified; check room dimensions, doors and clearances.',scan:scan?.measuredRooms>0?'Scan measurements may describe a representative unit.':'Room measurements could not be verified for this floor plan.'};
 if(p.mode==='commercial'){const business=commercialFacts(p,plan,criteria);return {fit:Object.fromEntries(Object.entries({...business.fit,distance:fit.distance,scan:fit.scan}).filter(([,v])=>v)),tradeoffs:Object.fromEntries(Object.entries({...business.tradeoffs,distance:tradeoffs.distance}).filter(([,v])=>v))}}
 return {fit:Object.fromEntries(Object.entries(fit).filter(([,v])=>v)),tradeoffs:Object.fromEntries(Object.entries(tradeoffs).filter(([,v])=>v))};
}
function scanEvidence(result){
 if(!result?.ok)return {measuredRooms:0,rooms:[]};
 const rooms=(result.model?.rooms||[]).filter(r=>String(r.label||'').toLowerCase()!=='void'&&['imperial','metric'].includes(r.dimensions?.units)&&(r.dimensions.areaFloorIndoor>0||r.dimensions.width>0&&r.dimensions.depth>0));
 return {measuredRooms:rooms.length,rooms:rooms.map(r=>({label:r.label||'Unlabeled room',dimensions:r.dimensions})).slice(0,12)};
}
export async function recommendProperties(properties,rawInput,{runAgent,loadScan=async()=>({ok:false}),onEvent=()=>{},resolvePlace=resolveMatchPlace,businessProfiles={}}={}){
 const input=normalizeMatchInput(rawInput);
 const obvious=obviousMatchIssue(input.needs);if(obvious){onEvent('request.declined',{code:obvious});return matchReply(obvious)}
 let candidates=[],criteria=null,finished=null,searches=0,inspections=0,analyzed=false;const inspected=new Map();
 const key=(p,l)=>p+':'+l;
 const tools={
  analyze_preferences:async analysis=>{
   if(analyzed)throw new MatchError('limit');analyzed=true;
   if(analysis.scope!=='housing'){finished=matchReply('out_of_scope');onEvent('request.declined',{code:'out_of_scope'});return finished}
   if(analysis.issue&&analysis.issue!=='none'){finished=matchReply(Object.hasOwn(MATCH_REPLIES,analysis.issue)?analysis.issue:'conflicting_needs');onEvent('request.clarification',{code:finished.code});return finished}
   if(analysis.mode&&analysis.mode!==input.mode){finished=matchReply('conflicting_needs',{message:'This request sounds like '+(analysis.mode==='commercial'?'a business space search':'a home search')+'. Switch search mode to continue?',actions:[{kind:'mode',label:analysis.mode==='commercial'?'Search business spaces':'Search homes',mode:analysis.mode}]});return finished}
   const filters=analysis.filters||{};
   if(input.descriptionFirst&&validCities.includes(filters.city))input.city=filters.city;
   if(filters.city&&filters.city!==input.city){finished=matchReply('conflicting_needs',{message:'Your city is '+input.city+', but your request refers to '+filters.city+'. Switch the city to continue?',actions:[{kind:'city',label:'Search '+filters.city,city:filters.city}]});return finished}
   criteria={...matchCriteria(input,filters),mode:input.mode};
   if(input.mode==='commercial'){
    const business=input.business||filters.business||'other',profile=businessProfiles[business];
    criteria.business=business;criteria.allowedUses=profile?.uses||null;criteria.businessWeights=profile?.customers||{};
    criteria.minSqft=input.minSqft??criteria.minSqft;criteria.maxSqft=input.maxSqft??filters.maxSqft??null;
    criteria.groundFloor=filters.groundFloor===true;criteria.kitchen=filters.kitchen===true;criteria.fitoutFeatures=business==='cafe'||business==='restaurant'||business==='bakery'?['kitchen_infrastructure','second_gen_restaurant']:business==='clinic'?['medical_buildout']:[];
    if(criteria.priority==='balanced')criteria.priority='business';
    if(criteria.minSqft!==null&&criteria.maxSqft!==null&&criteria.maxSqft<criteria.minSqft){finished=matchReply('conflicting_needs');return finished}
   }

   const suppliedZips=input.needs.match(/\b\d{5}\b/g)||[];criteria.zipCodes=criteria.zipCodes.filter(zip=>suppliedZips.includes(zip));
   if(criteria.maxBeds!==null&&criteria.beds!==null&&criteria.maxBeds<criteria.beds){finished=matchReply('conflicting_needs');return finished}
   const location=analysis.location||{};
   if(location.mode==='driving'||location.mode==='travel_time'){finished=matchReply('travel_time');return finished}
   if(location.query||input.locationChoiceId){
    const resolved=await resolvePlace({query:location.query,city:input.city,choiceId:input.locationChoiceId});
    if(resolved.status==='ambiguous'){finished=matchReply('ambiguous',{actions:resolved.choices.map(p=>({kind:'place',label:p.name,locationChoiceId:p.id}))});return finished}
    if(resolved.status!=='resolved'){finished=matchReply('location_unavailable');return finished}
    const place=resolved.place,city=supportedCityForPlace(place);
    if(!city){finished=matchReply('unsupported_city');return finished}
    if(input.descriptionFirst){input.city=city;criteria.city=city}
    if(city!==input.city){finished=matchReply('conflicting_needs',{message:place.name+' is near '+city+', but your city is '+input.city+'. Switch the city to continue?',actions:[{kind:'city',label:'Search '+city,city}]});return finished}
    const radius=input.radiusOverride??location.radiusMiles??null;
    if(radius!==null&&(!Number.isFinite(radius)||radius<=0||radius>500)){finished=matchReply('missing_radius');return finished}
    criteria.location=place;criteria.radiusMiles=radius;
    if(criteria.priority==='balanced')criteria.priority='distance';
    onEvent('location.resolved',{name:place.name,source:place.source,radiusMiles:radius,mode:'straight_line'});
   }
   if(input.radiusOverride!==null&&!criteria.location){finished=matchReply('location_unavailable');return finished}
   onEvent('preferences.analyzed',{criteria});return {status:'ready',criteria};
  },
  search_properties:async inferred=>{
   if(!analyzed)throw new MatchError('analysis_required');if(finished)return {status:finished.status,matches:[]};
   if(++searches>2)throw new MatchError('limit');
   const next=matchCriteria(input,inferred);
   if(criteria){for(const k of ['mode','business','allowedUses','businessWeights','fitoutFeatures','groundFloor','kitchen','maxSqft','minSqft','maxBeds','cats','zipCodes','location','radiusMiles','priority'])if(criteria[k]!==undefined)next[k]=criteria[k]}
   if(criteria){next.budget=criteria.budget===null?next.budget:next.budget===null?criteria.budget:Math.min(criteria.budget,next.budget);for(const k of ['beds','baths'])next[k]=criteria[k]===null?next[k]:Math.max(criteria[k],next[k]??0);next.dogs=criteria.dogs||next.dogs;next.parking=criteria.parking||next.parking}
   criteria=next;candidates=findMatchCandidates(properties,criteria);inspected.clear();
   onEvent('search.completed',{criteria,candidateLayouts:candidates.length,candidateProperties:new Set(candidates.map(r=>r.property.id)).size});
   return {criteria,matches:candidates.map(row=>({propertyId:row.property.id,planId:row.plan.id,name:row.property.name,plan:row.plan.name,rentMin:row.plan.rentMin,rentMax:row.plan.rentMax,beds:row.plan.beds,baths:row.plan.baths,area:row.plan.sqftMin,distanceMiles:row.distanceMiles,evidence:summaryFacts(row,criteria)}))};
  },
  inspect_scan_data:async ({selections})=>{
   if(finished)return {status:finished.status};
   if(!criteria||++inspections>1||!Array.isArray(selections)||selections.length>3)throw new MatchError('limit');
   const rows=selections.map(s=>candidates.find(r=>r.property.id===s.propertyId&&r.plan.id===s.planId));if(rows.some(r=>!r))throw new MatchError('invalid');
   const evidence=await Promise.all(rows.map(async row=>{
    const scans=await Promise.all(row.plan.tours.map(t=>loadScan(t.id).then(scanEvidence).catch(()=>({measuredRooms:0,rooms:[]}))));
    const scan=scans.sort((a,b)=>b.measuredRooms-a.measuredRooms)[0]||{measuredRooms:0,rooms:[]};inspected.set(key(row.property.id,row.plan.id),scan);
    return {propertyId:row.property.id,planId:row.plan.id,...scan,evidence:summaryFacts(row,criteria,scan)};
   }));
   onEvent('scans.completed',{selections:evidence.map(r=>({propertyId:r.propertyId,planId:r.planId,measuredRooms:r.measuredRooms}))});return evidence;
  },
  finish_shortlist:async ({selections,selectionMethod='model'})=>{
   if(finished)return {status:finished.status};
   if(!analyzed||!criteria||!Array.isArray(selections)||selections.length>3)throw new MatchError('invalid');
   const seen=new Set();const matches=selections.map(selection=>{
    const row=candidates.find(r=>r.property.id===selection.propertyId&&r.plan.id===selection.planId);if(!row||seen.has(row.property.id))throw new MatchError('invalid');seen.add(row.property.id);
    const scan=inspected.get(key(row.property.id,row.plan.id));const facts=summaryFacts(row,criteria,scan);
    let strengths=[...new Set(selection.strengthKeys||[])].filter(k=>Object.hasOwn(facts.fit,k)).slice(0,2);if(!strengths.length)strengths.push(Object.hasOwn(facts.fit,'rent')?'rent':'area');if(criteria.location)strengths=['distance',...strengths.filter(k=>k!=='distance')].slice(0,2);
    const tradeoff=Object.hasOwn(facts.tradeoffs,selection.tradeoffKey)?selection.tradeoffKey:'fees';
    return {propertyId:row.property.id,planId:row.plan.id,name:row.property.name,plan:row.plan.name,rentMin:row.plan.rentMin,strengths:strengths.map(k=>facts.fit[k]),tradeoff:tradeoff==='distance'||(tradeoff==='fees'&&row.property.mode!=='commercial')?'':facts.tradeoffs[tradeoff]};
   });
   if(matches.length!==Math.min(3,new Set(candidates.map(r=>r.property.id)).size))throw new MatchError('invalid');
   finished={ok:true,status:'matched',selectionMethod:selectionMethod==='validated_filters'?'validated_filters':'model',criteria,matches,eligibleProperties:new Set(candidates.map(r=>r.property.id)).size};
   if(!matches.length&&criteria.location&&criteria.radiusMiles!==null){
    const nearby=findMatchCandidates(properties,{...criteria,radiusMiles:null,priority:'distance'});
    if(nearby.length){const nextRadius=Math.ceil(nearby[0].distanceMiles*10)/10;finished={...matchReply('conflicting_needs'),status:'no_matches',code:'radius_no_matches',message:'No catalog properties meet all your requirements within '+criteria.radiusMiles+' miles. The closest eligible option is '+nearby[0].distanceMiles.toFixed(1)+' miles away (straight-line). Would you like to expand the radius?',actions:[{kind:'radius',label:'Try '+nextRadius+' miles',radiusOverride:nextRadius,locationChoiceId:criteria.location.id}]}}
   }
   onEvent('selection.completed',{selectionMethod:finished.selectionMethod,selections:matches.map(m=>({propertyId:m.propertyId,planId:m.planId,name:m.name,strengths:m.strengths,tradeoff:m.tradeoff}))});return {saved:true};
  }
 };
 await runAgent({input,tools});if(!finished)throw new MatchError('incomplete');return finished;
}
