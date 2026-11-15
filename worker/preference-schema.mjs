// Normalize formatting only. Unknown or malformed requirements must never become looser filters.
export function createPreferenceSchema(z){
 const empty=value=>value===undefined||value===null||value===''||value==='null';
 const optionalNumber=(min,max,integer=false,currency=false)=>z.preprocess(value=>{
  if(empty(value))return null;
  if(typeof value==='string'){
   const text=value.trim(),numeric=currency?text.replace(/^\$\s*/,''):text;
   if(/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(numeric))return Number(numeric.replaceAll(',',''));
  }
  return value;
 },(integer?z.number().int():z.number()).min(min).max(max).nullable());
 const optionalBoolean=z.preprocess(value=>empty(value)?false:value==='true'?true:value==='false'?false:value,z.boolean());
 const nullText=z.preprocess(value=>empty(value)?null:typeof value==='string'?value.trim()||null:value,z.string().max(180).nullable());
 const filters=z.object({
  city:z.preprocess(value=>empty(value)?null:typeof value==='string'?({'los angeles':'Los Angeles',houston:'Houston'}[value.trim().toLowerCase()]||value.trim()):value,z.enum(['Houston','Los Angeles']).nullable()),
  budget:optionalNumber(100,20000,false,true),beds:optionalNumber(0,6,true),baths:optionalNumber(.5,6),maxBeds:optionalNumber(0,6,true),minSqft:optionalNumber(50,20000),
  dogs:optionalBoolean,cats:optionalBoolean,parking:optionalBoolean,
  zipCodes:z.preprocess(value=>empty(value)?[]:typeof value==='string'?value.split(',').map(x=>x.trim()):value,z.array(z.string().regex(/^\d{5}$/)).max(12)),
  priority:z.preprocess(value=>empty(value)?'balanced':value,z.enum(['rent','space','distance','balanced']))
 });
 const location=z.object({query:nullText,radiusMiles:optionalNumber(.01,500),mode:z.preprocess(value=>empty(value)?'unspecified':value,z.enum(['straight_line','unspecified','driving','travel_time']))});
 return z.object({scope:z.enum(['housing','out_of_scope']),issue:z.preprocess(value=>empty(value)?'none':value,z.enum(['none','property_type','unsupported_city','travel_time','missing_radius','unsupported_requirement','conflicting_needs','per_person_budget','transaction'])),filters:z.preprocess(value=>empty(value)?{}:value,filters),location:z.preprocess(value=>empty(value)?{}:value,location)});
}
export function preferenceIssueDetails(issues,raw){
 const allowed=new Set(['scope','issue','filters','location','city','budget','beds','baths','maxBeds','minSqft','dogs','cats','parking','zipCodes','priority','query','radiusMiles','mode']);
 return issues.slice(0,8).map(issue=>{
  let value=raw;for(const key of issue.path)value=value&&Object.hasOwn(value,key)?value[key]:undefined;
  return {field:issue.path.map(key=>typeof key==='number'?key:allowed.has(key)?key:'field').join('.')||'request',code:issue.code,receivedType:value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value};
 });
}
// The model-facing schema stays plain JSON Schema; normalization runs only on the server.
export function createPreferenceToolSchema(z){
 const number=z.number().nullable().optional(),boolean=z.boolean().nullable().optional();
 return z.object({scope:z.enum(['housing','out_of_scope']),issue:z.enum(['none','property_type','unsupported_city','travel_time','missing_radius','unsupported_requirement','conflicting_needs','per_person_budget','transaction']).nullable().optional(),filters:z.object({city:z.enum(['Houston','Los Angeles']).nullable().optional(),budget:number,beds:number,baths:number,maxBeds:number,minSqft:number,dogs:boolean,cats:boolean,parking:boolean,zipCodes:z.array(z.string()).nullable().optional(),priority:z.enum(['rent','space','distance','balanced']).nullable().optional()}).nullable().optional(),location:z.object({query:z.string().nullable().optional(),radiusMiles:number,mode:z.enum(['straight_line','unspecified','driving','travel_time']).nullable().optional()}).nullable().optional()});
}
