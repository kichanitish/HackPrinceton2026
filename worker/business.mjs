// Business heuristics adapted from Scout's profiles and suite-level listing evidence.
export function commercialPlanMatches(property,plan,criteria){
 if(criteria.allowedUses?.length&&!criteria.allowedUses.includes(plan.use))return false;
 if(criteria.maxSqft!==null&&criteria.maxSqft!==undefined&&!(plan.sqftMin<=criteria.maxSqft))return false;
 if(criteria.groundFloor&&!plan.isGround)return false;
 if(criteria.kitchen){
  const mentions=(plan.features||[]).some(x=>['kitchen_infrastructure','second_gen_restaurant'].includes(x));
  if(!mentions||/\b(?:no|without|not)\b.{0,25}\b(?:kitchen|hood|grease)\b|\b(?:kitchen|hood)\b.{0,15}\b(?:not available|not installed|absent)\b/i.test(plan.notes||''))return false;
 }
 return true;
}
export function commercialFitScore(property,plan,criteria){
 const context=property.businessContext||{},weights=criteria.businessWeights||{};
 const demand=(weights.residents||0)*Math.log1p(context.nearbyApartmentUnits||0)+(weights.workers||0)*Math.log1p(context.officeBuildings||0);
 const sameUse=(context.tenantCategories||[]).includes(criteria.business)?1:0;
 const fitout=(plan.features||[]).some(x=>criteria.fitoutFeatures?.includes(x))?2:0;
 return demand+sameUse+fitout;
}
export function commercialFacts(property,plan,criteria){
 const money=n=>'$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:0}),context=property.businessContext||{};
 const fit={rent:plan.rentMin>0?money(plan.rentMin)+'/mo estimated base rent for '+Number(plan.sqftMin).toLocaleString()+' sq ft':null,area:plan.sqftMin>0?Number(plan.sqftMin).toLocaleString()+' sq ft minimum reported space':null,use:plan.use?'Listed for '+plan.use.replace(/([a-z])([A-Z])/g,'$1 $2')+' use':null,parking:property.parking?.length?'Building parking is recorded; allocation to this suite is unverified':null,fitout:plan.features?.some(x=>['kitchen_infrastructure','second_gen_restaurant'].includes(x))?'Broker notes mention food-service or kitchen infrastructure':null,context:context.officeBuildings>0?context.officeBuildings+' office buildings recorded within 0.5 mi':context.nearbyApartmentUnits>0?context.nearbyApartmentUnits+' apartment units recorded within 0.5 mi':null};
 const tradeoffs={fees:plan.rentMin>0?'Base rent is estimated from the asking rate and area; service charges, taxes and permitted use need confirmation.':'Asking rent is not reported. Confirm rent, charges and permitted use with the broker.',space:'Space and room fit are unverified for the exact suite; confirm dimensions and permitted business use.',business:'Business profiles are search guidance, not zoning, licensing, demand or revenue verification.',fitout:'Fit-out is a broker claim; verify installed equipment, utilities and approvals for your business.',parking:'Confirm spaces allocated to this suite and parking charges.',budget:criteria.budget!==null&&plan.rentMax>criteria.budget?'Larger areas or higher quoted rates may exceed your budget.':null,scan:'A building-level scan may not depict the offered suite.'};
 return {fit,tradeoffs};
}
