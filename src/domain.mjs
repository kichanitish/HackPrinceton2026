export function matchingPlans(property, filters={}) {
 if((property.mode||'home')!==(filters.mode||'home'))return [];
 if(filters.city && property.city!==filters.city)return [];
 const text=[property.name,property.address,property.zip,property.city].join(' ').toLowerCase();
 if(filters.query && !text.includes(filters.query.trim().toLowerCase()))return [];
 if(filters.dogs && (property.noPets===true || !property.pets.some(x=>['Dog','Cat'].includes(x.type))))return [];
 if(filters.parking && (property.noParking===true || !property.parking.length))return [];
 return property.plans.filter(p=>{
  if(!(p.available>0)||((property.mode||'home')==='home'&&!(p.rentMin>0)))return false;
  if(property.mode==='commercial'){
   const profile=typeof BUSINESS_PROFILES!=='undefined'?BUSINESS_PROFILES[filters.business]:null;
   if(profile?.uses&&!profile.uses.includes(p.use))return false;
   if(filters.minSqft&&p.sqftMin<Number(filters.minSqft)||filters.maxSqft&&p.sqftMin>Number(filters.maxSqft))return false;
   return !filters.budget||(p.rentMin>0&&p.rentMin<=Number(filters.budget));
  }
  if(filters.beds!==undefined && filters.beds!==''){
   const b=Number(filters.beds);
   if(b===3 ? !(p.beds>=3) : p.beds!==b)return false;
  }
  if(filters.baths!==undefined && filters.baths!==''){
   const b=Number(filters.baths);
   if(!Number.isFinite(p.baths)||(b===3 ? p.baths<3 : p.baths!==b))return false;
  }
  return !filters.budget || p.rentMin<=Number(filters.budget);
 });
}
export function selectPlan(property, filters, preferredId) {
 const plans=matchingPlans(property,filters);
 return plans.find(p=>p.id===Number(preferredId)) || [...plans].sort((a,b)=>(a.rentMin??Infinity)-(b.rentMin??Infinity))[0] || null;
}
export function normalizeSelections(input,properties){
 const selected=[];
 for(const item of Array.isArray(input)?input:[]){
  const property=properties.find(p=>p.id===Number(item.propertyId));
  if(!property || selected.some(x=>x.propertyId===property.id))continue;
  const plan=property.plans.find(p=>p.id===Number(item.planId));
  if(plan)selected.push({propertyId:property.id,planId:plan.id});
  if(selected.length===3)break;
 }
 return selected;
}
export function comparisonInsights(entries){
 if(entries.length<2)return [];
 const notes=[];
 const sorted=[...entries].sort((a,b)=>a.plan.rentMin-b.plan.rentMin);
 const low=sorted[0],high=sorted.at(-1),difference=high.plan.rentMin-low.plan.rentMin;
 if(difference>0)notes.push({kind:'rent',propertyId:low.property.id,difference,text:low.property.name+' starts $'+difference.toLocaleString('en-US')+'/month below '+high.property.name+'. These are minimum asking rents, before fees.'});
 const known=entries.filter(x=>x.plan.sqftMin>0).sort((a,b)=>b.plan.sqftMin-a.plan.sqftMin);
 if(known.length>1 && known[0].plan.sqftMin>known.at(-1).plan.sqftMin)notes.push({kind:'space',propertyId:known[0].property.id,text:known[0].property.name+' has the largest reported minimum floor-plan area: '+known[0].plan.sqftMin.toLocaleString('en-US')+' sq ft.'});
 if(new Set(entries.map(x=>x.plan.beds)).size>1)notes.push({kind:'beds',text:'These floor plans have different bedroom counts. Keep that difference in mind when comparing rent and space.'});
 if(new Set(entries.map(x=>x.property.city)).size>1)notes.push({kind:'city',text:'These properties are in different cities. Prices reflect different local markets.'});
 return notes;
}
export function latestAerialCollection(collections=[]){
 const date=collection=>{const value=Date.parse(collection.lastCapture||collection.firstCapture||'');return Number.isFinite(value)?value:-Infinity};
 return [...collections].sort((a,b)=>{const ad=date(a),bd=date(b);return ad===bd?Number(b.layer==='urban')-Number(a.layer==='urban'):bd-ad})[0]||null;
}
