let matchController=null,matchDraft=null,matchRecommendation=null,matchUndo=null,matchRefinements={};
const needsDrafts={home:'',commercial:''};
function updateNeedsMode(mode=$('purpose').value||'home'){
 const commercial=mode==='commercial',city=$('city').value||'Houston';
 const previous=$('matchNeeds').dataset.mode;
 if(previous&&previous!==mode){needsDrafts[previous]=$('matchNeeds').value;$('matchNeeds').value=needsDrafts[mode]||'';$('matchStatus').textContent='';$('matchFollowups').hidden=true;matchRefinements={}}
 $('matchNeeds').dataset.mode=mode;
 $('homeHero').hidden=commercial;$('businessHero').hidden=!commercial;
 $('homeExample').hidden=commercial;$('businessExample').hidden=!commercial;
 $('homeExample').textContent='Two bedrooms in '+city+' under $2,000, with room for two desks.';
 $('businessExample').textContent='A coffee shop in '+city+', 800–2,000 sq ft, under $4,000 a month.';
 $('matchNeeds').placeholder=commercial?'Describe your business, budget, location, and the space you need…':'Tell us your budget, location, room needs, and what matters to you…';
}
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
 const note=match.tradeoff.replaceAll('Straight-line distance; driving miles and traffic are not verified.','').replaceAll('Mandatory fees and exact unit pricing still need confirmation.','').trim();
 return '<div class="match-explanation"><span class="match-summary-label">Agent summary</span><ul><li>'+escape(match.strengths.join(' · '))+'</li>'+(note?'<li>'+escape(note)+'</li>':'')+'</ul>'+source+'</div>';
}
function renderMatchContext(){
 $('matchContext').hidden=!matchUndo;$('matchContextText').textContent='Shortlist updated.';$('undoMatches').hidden=!matchUndo;
}
function persistMatchRecommendation(){try{if(matchRecommendation)localStorage.setItem('homefit-matches-v1',JSON.stringify(matchRecommendation));else localStorage.removeItem('homefit-matches-v1')}catch{}}
function restoreMatchRecommendation(){try{const result=JSON.parse(localStorage.getItem('homefit-matches-v1')||'null');if(validMatchResult(result))matchRecommendation=result}catch{}}
function focusNeedsSearch(){
 showView('explore');$('needsSearch').scrollIntoView({behavior:'smooth',block:'center'});$('matchNeeds').focus({preventScroll:true});
}
function startNeedsSearch(event){
 event.preventDefault();if(matchController)return;
 if(!$('matchNeeds').value.trim()){$('matchStatus').textContent='Tell us a little about the place you’re looking for.';return}
 if(!config.recommendationsConfigured){$('matchStatus').textContent='Matching is unavailable right now. You can still browse with the filters and build your shortlist.';return}
 const f=filters();$('matchMode').value=f.mode||'home';$('matchCity').value=f.city||'Houston';
 // This search uses the description; browsing filters must not silently add constraints.
 for(const id of ['matchBusiness','matchMinArea','matchMaxArea','matchBudget','matchBeds','matchBaths'])$(id).value='';
 $('matchDogs').checked=false;matchRefinements={};return findPersonalMatches(event);
}
function cancelPersonalMatches(){
 matchController?.abort();matchController=null;matchDraft=null;
 $('matchSubmit').disabled=false;$('matchSubmit').textContent='Find matches';$('matchForm').setAttribute('aria-busy','false');$('cancelMatches').hidden=true;$('matchNeeds').readOnly=false;for(const id of ['homeExample','businessExample'])$(id).disabled=false;
 $('matchStatus').textContent='Search cancelled. Your shortlist hasn’t changed.';
}
async function findPersonalMatches(event){
 event.preventDefault();if(matchController||!config.recommendationsConfigured)return;
 const read=id=>$(id).value===''?null:Number($(id).value);
 const businessMode=$('matchMode').value==='commercial';
 const input={descriptionFirst:true,mode:businessMode?'commercial':'home',business:businessMode?$('matchBusiness').value||null:null,minSqft:businessMode?read('matchMinArea'):null,maxSqft:businessMode?read('matchMaxArea'):null,city:$('matchCity').value,budget:read('matchBudget'),beds:businessMode?null:read('matchBeds'),baths:businessMode?null:read('matchBaths'),dogs:!businessMode&&$('matchDogs').checked,needs:$('matchNeeds').value.trim(),...matchRefinements};
 matchDraft=null;$('matchFollowups').hidden=true;
 const controller=new AbortController();matchController=controller;const timer=setTimeout(()=>controller.abort('timeout'),70000);
 $('matchSubmit').disabled=true;$('matchSubmit').textContent='Finding matches…';$('cancelMatches').hidden=false;$('matchNeeds').readOnly=true;for(const id of ['homeExample','businessExample'])$(id).disabled=true;$('matchForm').setAttribute('aria-busy','true');$('matchStatus').textContent='Finding places that fit, and checking the available facts…';
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
 finally{clearTimeout(timer);if(controller===matchController){matchController=null;$('matchSubmit').disabled=false;$('matchSubmit').textContent='Find matches';$('matchForm').setAttribute('aria-busy','false');$('cancelMatches').hidden=true;$('matchNeeds').readOnly=false;for(const id of ['homeExample','businessExample'])$(id).disabled=false}}
}
function renderMatchFollowups(actions){
 const root=$('matchFollowups');root.replaceChildren();
 for(const action of actions.slice(0,3)){
  if(!['city','place','radius','mode'].includes(action.kind)||typeof action.label!=='string')continue;
  const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=action.label;
  button.onclick=()=>{
   if(action.kind==='mode'&&['home','commercial'].includes(action.mode)){$('matchMode').value=action.mode;updateMatchMode();matchRefinements={}}
   else if(action.kind==='city'&&['Houston','Los Angeles'].includes(action.city)){$('matchCity').value=action.city;matchRefinements={}}
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
 if(matchDraft.criteria.mode&&matchDraft.criteria.mode!==($('purpose').value||'home')){needsDrafts[matchDraft.criteria.mode]=$('matchNeeds').value;setBrowsePurpose(matchDraft.criteria.mode)}
 selected=matchDraft.matches.map(m=>({propertyId:m.propertyId,planId:m.planId}));for(const m of selected)preferred[m.propertyId]=m.planId;
 matchRecommendation=matchDraft;persistMatchRecommendation();save();$('matchStatus').textContent='Your matches are ready in My shortlist.';render();showView('comparison');
}
function undoPersonalMatches(){
 if(!matchUndo)return;selected=matchUndo.selected;preferred=matchUndo.preferred;matchRecommendation=matchUndo.recommendation;matchUndo=null;persistMatchRecommendation();save();render();showView('comparison');
}
$('shortlistFindMatches').onclick=focusNeedsSearch;$('matchForm').onsubmit=startNeedsSearch;$('undoMatches').onclick=undoPersonalMatches;$('cancelMatches').onclick=cancelPersonalMatches;
$('matchForm').addEventListener('input',()=>{matchRefinements={};$('matchFollowups').hidden=true;if(!matchController)$('matchStatus').textContent=''});
for(const id of ['homeExample','businessExample'])$(id).onclick=()=>{$('matchNeeds').value=$(id).textContent.trim();matchRefinements={};$('matchFollowups').hidden=true;$('matchStatus').textContent='';$('matchNeeds').focus()};
$('matchNeeds').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();startNeedsSearch(event)}});
$('city').addEventListener('change',()=>updateNeedsMode());
for(const id of ['homeHero','businessHero'])$(id).addEventListener('error',()=>{$(id).style.visibility='hidden'});
