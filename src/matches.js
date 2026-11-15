let matchController=null,matchDraft=null,matchRecommendation=null,matchUndo=null,matchRefinements={};
function validMatchResult(result){
 if(!result?.ok||!Array.isArray(result.matches)||result.matches.length>3||!result.criteria)return false;
 const seen=new Set();return result.matches.every(m=>{const p=propertyMap.get(m.propertyId),plan=p?.plans.find(x=>x.id===m.planId);if(!plan||seen.has(p.id)||!Array.isArray(m.strengths)||!m.strengths.length||m.strengths.length>2||!m.strengths.every(s=>typeof s==='string'&&s.length<=300)||typeof m.tradeoff!=='string'||m.tradeoff.length>300)return false;seen.add(p.id);return true});
}
function activeMatchRecommendation(){
 if(!validMatchResult(matchRecommendation))return null;
 const matches=matchRecommendation.matches.filter(m=>selected.some(s=>s.propertyId===m.propertyId&&s.planId===m.planId));
 return matches.length?{...matchRecommendation,matches}:null;
}
function matchColumnMarkup(p,plan){
 const match=activeMatchRecommendation()?.matches.find(m=>m.propertyId===p.id&&m.planId===plan.id);if(!match)return '';
 const location=activeMatchRecommendation()?.criteria.location;const source=location?.sourceUrl==='https://www.openstreetmap.org/copyright'?'<a class="match-location-source" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>':'';
 return '<div class="match-explanation"><span class="match-summary-label">Agent summary</span><ul><li>'+escape(match.strengths.join(' · '))+'</li><li>'+escape(match.tradeoff)+'</li></ul>'+source+'</div>';
}
function renderMatchContext(){
 $('matchContext').hidden=!matchUndo;$('matchContextText').textContent='Shortlist updated.';$('undoMatches').hidden=!matchUndo;
}
function persistMatchRecommendation(){try{if(matchRecommendation)localStorage.setItem('homefit-matches-v1',JSON.stringify(matchRecommendation));else localStorage.removeItem('homefit-matches-v1')}catch{}}
function restoreMatchRecommendation(){try{const result=JSON.parse(localStorage.getItem('homefit-matches-v1')||'null');if(validMatchResult(result))matchRecommendation=result}catch{}}
function openMatchDialog(){
 const f=filters();if(!matchRecommendation){$('matchCity').value=f.city||'Houston';$('matchBudget').value=f.budget;$('matchBeds').value=f.beds;$('matchBaths').value=f.baths;$('matchDogs').checked=f.dogs}
 $('matchSubmit').disabled=!config.recommendationsConfigured||!!matchController;
 $('matchStatus').textContent=config.recommendationsConfigured?'':'Personalized matches are unavailable right now. You can still explore with the filters and build your shortlist.';
 $('matchReplaceNote').hidden=!selected.length;matchDraft=null;matchRefinements={};$('matchFollowups').hidden=true;$('matchDialog').showModal();
}
async function findPersonalMatches(event){
 event.preventDefault();if(matchController||!config.recommendationsConfigured)return;
 const read=id=>$(id).value===''?null:Number($(id).value);
 const input={city:$('matchCity').value,budget:read('matchBudget'),beds:read('matchBeds'),baths:read('matchBaths'),dogs:$('matchDogs').checked,needs:$('matchNeeds').value.trim(),...matchRefinements};
 matchDraft=null;$('matchFollowups').hidden=true;
 const controller=new AbortController();matchController=controller;const timer=setTimeout(()=>controller.abort('timeout'),70000);
 $('matchSubmit').disabled=true;$('matchSubmit').textContent='Finding your matches…';$('matchForm').setAttribute('aria-busy','true');$('matchStatus').textContent='Looking through listing facts and available scan measurements. This may take a moment.';
 try{
  const response=await fetch('/api/recommend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:controller.signal});const result=await response.json();
  if(controller!==matchController)return;
  if(response.ok&&['out_of_scope','clarification','no_matches'].includes(result.status)&&typeof result.message==='string'){
   $('matchStatus').textContent=result.message;renderMatchFollowups(result.actions||[]);return;
  }
  if(!response.ok||!validMatchResult(result)){
   const message=result.code==='busy'?'Matching is busy right now. Please try again shortly.':result.code==='invalid'?'Please check your requirements and try again.':'We couldn’t finish your matches. Please try again; your shortlist hasn’t changed.';throw Object.assign(new Error(message),{userFacing:true});
  }
  if(!result.matches.length){$('matchStatus').textContent='No properties matched all your requirements. Try adjusting your budget or room counts.';return}
  matchDraft=result;applyPersonalMatches();

 }catch(error){if(controller===matchController)$('matchStatus').textContent=controller.signal.aborted?'Matching took too long. Please try again; your shortlist hasn’t changed.':error.userFacing?error.message:'We couldn’t reach matching right now. Please try again; your shortlist hasn’t changed.'}
 finally{clearTimeout(timer);if(controller===matchController){matchController=null;$('matchSubmit').disabled=false;$('matchSubmit').textContent='Find my matches';$('matchForm').setAttribute('aria-busy','false')}}
}
function renderMatchFollowups(actions){
 const root=$('matchFollowups');root.replaceChildren();
 for(const action of actions.slice(0,3)){
  if(!['city','place','radius'].includes(action.kind)||typeof action.label!=='string')continue;
  const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=action.label;
  button.onclick=()=>{
   if(action.kind==='city'&&['Houston','Los Angeles'].includes(action.city)){$('matchCity').value=action.city;matchRefinements={}}
   else if(action.kind==='place'&&typeof action.locationChoiceId==='string')matchRefinements.locationChoiceId=action.locationChoiceId;
   else if(action.kind==='radius'&&Number.isFinite(action.radiusOverride)&&action.radiusOverride>0&&action.radiusOverride<=500)matchRefinements={locationChoiceId:action.locationChoiceId,radiusOverride:action.radiusOverride};
   else return;
   return findPersonalMatches({preventDefault(){}});
  };
  root.append(button);
 }
 root.hidden=!root.children.length;
}
function applyPersonalMatches(){
 if(!validMatchResult(matchDraft)||!matchDraft.matches.length)return;
 matchUndo={selected:selected.map(s=>({...s})),preferred:{...preferred},recommendation:matchRecommendation};
 selected=matchDraft.matches.map(m=>({propertyId:m.propertyId,planId:m.planId}));for(const m of selected)preferred[m.propertyId]=m.planId;
 matchRecommendation=matchDraft;persistMatchRecommendation();save();$('matchDialog').close();render();showView('comparison');
}
function undoPersonalMatches(){
 if(!matchUndo)return;selected=matchUndo.selected;preferred=matchUndo.preferred;matchRecommendation=matchUndo.recommendation;matchUndo=null;persistMatchRecommendation();save();render();showView('comparison');
}
$('findMatches').onclick=openMatchDialog;$('shortlistFindMatches').onclick=openMatchDialog;$('matchForm').onsubmit=findPersonalMatches;$('undoMatches').onclick=undoPersonalMatches;
$('matchForm').addEventListener('input',()=>{matchRefinements={};$('matchFollowups').hidden=true});
$('matchDialog').addEventListener('close',()=>{matchController?.abort();matchController=null;$('matchSubmit').textContent='Find my matches';$('matchForm').setAttribute('aria-busy','false')});
