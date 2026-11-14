/*__DOMAIN__*/
/*__TOUR__*/
const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>value===null||value===undefined?'Not reported':'$'+Number(value).toLocaleString('en-US');
const number=value=>value===null||value===undefined?'Not reported':Number(value).toLocaleString('en-US');
const bedsText=value=>value===0?'Studio':value==null?'Beds unknown':value+' bed'+(value===1?'':'s');
const sqftText=p=>p.sqftMin>0?number(p.sqftMin)+(p.sqftMax>p.sqftMin?'–'+number(p.sqftMax):'')+' sq ft':'Size not reported';
const rentText=p=>money(p.rentMin)+(p.rentMax>p.rentMin?'–'+money(p.rentMax):'');
const tourIcon='<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m9 1 7 4v8l-7 4-7-4V5Z M2 5l7 4 7-4 M9 9v8"/></svg>';
let properties=[],selected=[],preferred={},visible=12,currentView='explore',sdk=null,tourSession=0,toastTimer,config={},checking=false;
let sdkEvidence=null,connectionRows=[];
let liveModelCache=new Map(),liveModelJobs=new Map(),sdkRooms=[],sdkSweeps=[],sdkSubscriptions=[],activeModelData=null,walkRun=0;
const propertyMap=new Map();
function filters(){return {city:$('city').value,beds:$('beds').value,budget:$('budget').value,query:$('query').value,dogs:$('dogs').checked,parking:$('parking').checked}}
function save(){try{localStorage.setItem('homefit-shortlist-v1',JSON.stringify(selected))}catch{}updateURL()}
function updateURL(){const url=new URL(location.href);if(selected.length)url.searchParams.set('compare',selected.map(x=>x.propertyId+':'+x.planId).join(','));else url.searchParams.delete('compare');url.hash=currentView==='comparison'?'compare':'';try{history.replaceState(null,'',url)}catch{}}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000)}
function photo(p,cls='',lazy=true){return p.photo?'<img class="'+cls+'" src="'+escape(p.photo)+'" alt="'+escape(p.name)+' property photo" '+(lazy?'loading="lazy"':'')+' referrerpolicy="no-referrer">':'<div class="image-fallback">'+escape(p.name)+'</div>'}
function attachImageFallbacks(root=document){root.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{const fallback=document.createElement('div');fallback.className=img.className.includes('compare-photo')?'image-fallback compare-photo':'image-fallback';fallback.textContent='Photo unavailable';img.replaceWith(fallback)},{once:true}))}
function getSelection(item){const property=propertyMap.get(item.propertyId),plan=property?.plans.find(p=>p.id===item.planId);return property&&plan?{property,plan}:null}
function entries(){return selected.map(getSelection).filter(Boolean)}
function planOptions(plans,chosen){return plans.map(p=>'<option value="'+p.id+'" '+(p.id===chosen.id?'selected':'')+'>'+escape(p.name)+' · '+bedsText(p.beds)+' · '+money(p.rentMin)+'+</option>').join('')}
function render(){
 if(!properties.length)return;
 const f=filters();let list=properties.map(p=>({property:p,plan:selectPlan(p,f,preferred[p.id]),plans:matchingPlans(p,f)})).filter(x=>x.plan);
 if($('sort').value==='price')list.sort((a,b)=>a.plan.rentMin-b.plan.rentMin);
 if($('sort').value==='size')list.sort((a,b)=>(b.plan.sqftMin||0)-(a.plan.sqftMin||0));
 $('resultCount').textContent=list.length.toLocaleString()+' properties · Available floor plans with linked tours';
 $('cards').innerHTML=list.slice(0,visible).map(({property:p,plan,plans})=>{
  const checked=selected.some(s=>s.propertyId===p.id);
  return '<article class="card '+(checked?'selected':'')+'" data-property="'+p.id+'"><div class="card-media">'+photo(p)+'<button class="select-round" data-add="'+p.id+'" aria-label="'+(checked?'Remove ':'Compare ')+escape(p.name)+'" aria-pressed="'+checked+'">'+(checked?'✓':'+')+'</button><button class="tour-badge" data-tour="'+p.id+'" data-plan="'+plan.id+'">'+tourIcon+'Explore in 3D</button></div><div class="card-content"><div class="card-topline"><span class="city-label">'+escape(p.city)+'</span><span class="availability">'+plan.available+' reported available</span></div><h3>'+escape(p.name)+'</h3><p class="card-address">'+escape(p.address)+', '+escape(p.zip)+'</p><select class="plan-select" data-plan-select="'+p.id+'" aria-label="Floor plan at '+escape(p.name)+'">'+planOptions(plans,plan)+'</select><div class="plan-facts"><span>'+bedsText(plan.beds)+'</span><span>'+number(plan.baths)+' bath</span><span>'+sqftText(plan)+'</span></div><div class="card-bottom"><div class="rent">'+money(plan.rentMin)+'<small>/mo</small><span class="rent-sub">Starting asking rent · fees extra</span></div><button class="details-link" data-details="'+p.id+'" data-plan="'+plan.id+'">View details ↗</button></div></div></article>';
 }).join('');
 $('empty').hidden=!!list.length;$('loadMore').hidden=list.length<=visible;
 attachImageFallbacks($('cards'));renderTray();
}
function renderTray(){
 $('navCount').textContent=selected.length;$('trayCount').textContent=selected.length+' / 3';
 $('tray').hidden=!selected.length||currentView!=='explore';$('compareButton').disabled=selected.length<2;
 $('trayItems').innerHTML=entries().map(({property:p})=>'<div class="tray-item">'+(p.photo?'<img src="'+escape(p.photo)+'" alt="">':'')+'<span>'+escape(p.name)+'</span><button data-remove="'+p.id+'" aria-label="Remove '+escape(p.name)+'">×</button></div>').join('');
 attachImageFallbacks($('tray'));
}
function toggleSelection(propertyId,planId){
 const i=selected.findIndex(x=>x.propertyId===propertyId);
 if(i>=0){selected.splice(i,1)}else{
  if(selected.length===3){toast('Compare up to 3 properties. Remove one to add another.');return}
  const p=propertyMap.get(propertyId),plan=p?.plans.find(x=>x.id===planId)||selectPlan(p,filters(),preferred[propertyId]);
  if(!plan)return;selected.push({propertyId,planId:plan.id});
 }
 save();render();if(currentView==='comparison')renderComparison();
}
function showView(view){currentView=view;$('explore').hidden=view!=='explore';$('comparison').hidden=view!=='comparison';$('browseNav').classList.toggle('active',view==='explore');$('compareNav').classList.toggle('active',view==='comparison');if(view==='comparison')renderComparison();renderTray();updateURL();window.scrollTo({top:0,behavior:'instant'})}
function petSummary(p){if(p.noPets===true)return 'No pets allowed in the recorded policy';const dog=p.pets.find(x=>x.type==='Dog');return dog?'Dogs considered'+(dog.rent!=null?' · '+money(dog.rent)+'/pet/month':' · monthly pet rent not reported'):'Dog policy not reported'}
function parkingSummary(p){if(p.noParking===true)return 'No parking available in the recorded policy';if(!p.parking.length)return 'Not reported';return [...new Set(p.parking.map(x=>x.type.replace(/([a-z])([A-Z])/g,'$1 $2')))].join(', ')}
function parkingFee(p){const fees=p.parking.filter(x=>x.minFee!=null);return fees.length?'Recorded starting fee: '+money(Math.min(...fees.map(x=>x.minFee)))+'/space; frequency not reported':'Parking fees not reported'}
function renderComparison(){
 const items=entries();$('exportButton').hidden=items.length<2;
 if(items.length<2){$('comparisonContent').innerHTML='<div class="comparison-empty"><h2>A good decision starts with a comparison.</h2><p>Select at least two properties using the + button while exploring.</p><button class="primary" data-explore>Explore properties</button></div>';return}
 const insights=comparisonInsights(items);
 const row=(label,fn)=>'<tr><th scope="row">'+label+'</th>'+items.map(x=>'<td>'+fn(x)+'</td>').join('')+'</tr>';
 const min=Math.min(...items.map(x=>x.plan.rentMin));
 let html='<div class="compare-scroll"><table class="comparison-table '+(items.length===2?'two':'')+'"><caption class="sr-only">Selected apartment properties and floor plans</caption><thead><tr><th scope="col">THE SHORTLIST</th>'+items.map(({property:p,plan})=>'<th scope="col">'+photo(p,'compare-photo',false)+'<div class="city-label">'+escape(p.city)+'</div><h2 class="compare-property-name">'+escape(p.name)+'</h2><span class="muted">'+escape(p.address)+'</span><select class="plan-select" data-compare-plan="'+p.id+'" aria-label="Compare floor plan at '+escape(p.name)+'">'+planOptions(p.plans,plan)+'</select><div class="table-actions"><button class="secondary" data-tour="'+p.id+'" data-plan="'+plan.id+'">'+tourIcon+'3D tour</button><button class="text-button" data-remove="'+p.id+'">Remove</button></div></th>').join('')+'</tr></thead><tbody>';
 html+=row('ASKING RENT',({plan})=>'<div class="rent">'+rentText(plan)+'<small>/mo</small></div>'+(plan.rentMin===min?'<span class="winner">Lowest starting rent</span>':'')+'<span class="rent-sub">Whole-unit pricing · excludes fees</span>');
 html+=row('FLOOR PLAN',({plan})=>'<strong>'+escape(plan.name)+'</strong><br>'+bedsText(plan.beds)+' · '+number(plan.baths)+' bath');
 html+=row('REPORTED AREA',({plan})=>sqftText(plan));
 html+=row('RENT / SQ FT',({plan})=>plan.sqftMin>0?money((plan.rentMin/plan.sqftMin).toFixed(2))+'/sq ft/month<br><span class="muted">Minimum rent ÷ minimum area</span>':'Not reported');
 html+=row('AVAILABILITY',({plan})=>number(plan.available)+' units reported<br><span class="muted">Snapshot, not live inventory</span>');
 html+=row('DOG POLICY',({property:p})=>escape(petSummary(p)));
 html+=row('PARKING',({property:p})=>escape(parkingSummary(p))+'<br><span class="muted">'+escape(parkingFee(p))+'</span>');
 html+=row('BUILDING',({property:p})=>escape(p.style==='Unknown'?'Style not reported':p.style.replace(/([a-z])([A-Z])/g,'$1 $2'))+(p.stories?' · '+p.stories+' stories':'')+(p.units?'<br>'+number(p.units)+' units in community':''));
 html+=row('TOUR EVIDENCE',({plan})=>escape(plan.tours[0].scope)+' scan<br><span class="muted">May differ from the offered unit</span>');
 html+=row('MANAGEMENT',({property:p})=>escape(p.manager||'Not reported'));
 html+=row('STILL TO VERIFY',()=>'<span class="muted">Exact unit and price; deposits; utilities; mandatory fees; current availability.</span>');
 html+='</tbody></table></div>';
 html+='<div class="comparison-note"><span class="insight-heading">A few useful differences</span>'+(insights.length?insights.map(x=>'<p>'+escape(x.text)+'</p>').join(''):'The selected plans have the same starting rent and reported minimum area. Compare their policies and tours.')+'<p>Source: supplied CoStar snapshot, November 12, 2026. Comparisons use reported facts; no AI assessment or live availability is implied.</p></div>';
 $('comparisonContent').innerHTML=html;attachImageFallbacks($('comparisonContent'));
 renderCompareLive(items);
}
function detail(propertyId,planId){
 const p=propertyMap.get(propertyId);if(!p)return;const plan=p.plans.find(x=>x.id===planId)||p.plans[0];
 const pets=p.noPets===true?'<p>No pets allowed in the recorded policy.</p>':p.pets.length?p.pets.map(x=>'<div class="policy"><strong>'+escape(x.type)+'</strong><p>'+(x.rent!=null?money(x.rent)+'/pet/month':'Monthly pet rent not reported')+(x.limit?' · limit '+x.limit:'')+'</p>'+(x.minFee!=null?'<p>Recorded pet fee: '+money(x.minFee)+(x.maxFee>x.minFee?'–'+money(x.maxFee):'')+'; frequency not specified</p>':'')+(x.weight?'<p>Recorded pet weight threshold: '+number(x.weight)+' lb</p>':'')+(x.restrictions?'<p>'+escape(x.restrictions)+'</p>':'')+'</div>').join(''):'<p class="muted">Pet policies not reported.</p>';
 const parking=p.noParking===true?'<p>No parking available in the recorded policy.</p>':p.parking.length?p.parking.map(x=>'<div class="policy"><strong>'+escape(x.type.replace(/([a-z])([A-Z])/g,'$1 $2'))+'</strong><p>'+(x.minFee!=null?money(x.minFee)+(x.maxFee>x.minFee?'–'+money(x.maxFee):'')+'/space; frequency not reported':'Fees not reported')+'</p>'+(x.notes?'<p>'+escape(x.notes)+'</p>':'')+'</div>').join(''):'<p class="muted">Parking policies not reported.</p>';
 $('detailContent').innerHTML='<div class="detail-image">'+photo(p,'',false)+'<button class="icon-button" data-close="detailDialog" aria-label="Close property details">×</button></div><div class="detail-body"><span class="city-label">'+escape(p.city)+' · '+escape(p.zip)+'</span><h2>'+escape(p.name)+'</h2><p class="detail-address">'+escape(p.address)+', '+escape(p.city)+', '+escape(p.state)+'</p><div class="detail-facts"><div><span>ASKING RENT</span><strong>'+rentText(plan)+'/mo</strong></div><div><span>FLOOR PLAN</span><strong>'+bedsText(plan.beds)+' · '+number(plan.baths)+' bath</strong></div><div><span>REPORTED SIZE</span><strong>'+sqftText(plan)+'</strong></div><div><span>AVAILABILITY</span><strong>'+plan.available+' reported</strong></div></div><select class="plan-select" data-detail-plan="'+p.id+'" aria-label="Floor plan details">'+planOptions(p.plans,plan)+'</select><div class="detail-actions"><button class="primary" data-tour="'+p.id+'" data-plan="'+plan.id+'">'+tourIcon+'Step inside</button><button class="secondary" data-add="'+p.id+'" data-plan="'+plan.id+'">'+(selected.some(x=>x.propertyId===p.id)?'Remove from comparison':'Add to comparison')+'</button><a class="text-button" href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(p.address+', '+p.city+', '+p.state)+'" target="_blank" rel="noopener noreferrer">View location ↗</a></div><h3>Pet policies</h3><div class="policy-list">'+pets+'</div><h3>Parking</h3><div class="policy-list">'+parking+'</div><p class="source-note">CoStar property #'+p.id+' · Floor plan #'+plan.id+' · November 12, 2026.<br>Policies and fees may be incomplete. Confirm all charges and the exact available unit with the property.</p></div>';
 attachImageFallbacks($('detailDialog'));if(!$('detailDialog').open)$('detailDialog').showModal();
 renderDetailLive(p,plan);
}
function timeout(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Connection timed out')),ms))]).finally(()=>clearTimeout(timer))}
function updateSdkEvidence(state){
 sdkEvidence=state;showConnections(connectionRows);
 if(state.connected){
  const suffix=state.guidedState==='checking'?'checking guided tour…':state.guidedState==='ready'?state.stopCount+' saved tour stops':state.guidedState==='empty'?'no saved guided tour':'guided-tour check failed';
  $('sdkStatus').textContent='SDK connected · '+state.label+' · '+suffix;
  $('panButton').disabled=false;
  $('playTour').disabled=state.guidedState!=='ready';
  $('playTour').textContent=state.guidedState==='empty'?'No saved tour':state.guidedState==='failed'?'Tour check failed':'Play guided tour';
  $('playTour').title=state.guidedState==='empty'?'This model returned no saved guided-tour stops.':state.guidedState==='failed'?'Saved-tour discovery failed. Camera controls are still connected.':state.guidedState==='checking'?'Checking for saved guided-tour stops…':'';
 }
}
async function openTour(propertyId,planId){
 const p=propertyMap.get(propertyId),plan=p?.plans.find(x=>x.id===planId);if(!plan)return;
 $('detailDialog').close();clearSdkRoomData();sdk=null;const token=++tourSession,tour=plan.tours[0];
 $('tourTitle').textContent=p.name+' · '+plan.name;$('tourScope').textContent=tour.scope+' · Model '+tour.id;
 $('sdkStatus').textContent='Connecting to Matterport…';$('panButton').disabled=true;$('playTour').disabled=true;$('playTour').textContent='Play guided tour';$('playTour').title='Waiting for an SDK connection';
 $('externalTour').href='https://my.matterport.com/show/?m='+encodeURIComponent(tour.id);
 const frame=document.createElement('iframe');frame.title='Matterport tour of '+p.name;frame.allow='fullscreen; xr-spatial-tracking';frame.allowFullscreen=true;
 const url=new URL('https://my.matterport.com/show/');url.searchParams.set('m',tour.id);url.searchParams.set('play','1');if(config.sdkKey)url.searchParams.set('applicationKey',config.sdkKey);frame.src=url;
 $('tourFrame').replaceChildren(frame);$('tourDialog').showModal();
 $('modelArea').textContent='';$('roomStatus').textContent='Loading Matterport room measurements…';$('roomList').replaceChildren();
 $('snapshotButton').disabled=true;$('autoWalk').disabled=true;document.querySelectorAll('[data-view]').forEach(b=>b.disabled=true);
 loadModel(tour.id).then(result=>{if(token!==tourSession)return;activeModelData=result;renderTourRooms()});
 if(!config.sdkKey){$('sdkStatus').textContent='Standard viewer · SDK key not configured';return}
 sdkEvidence={connected:false,state:'Connecting',modelId:tour.id};showConnections(connectionRows);
 try{
  const lib=await timeout(import('https://api.matterport.com/sdk/bootstrap/3.1.0-0-g1cd7e0997a/sdk.es6.js?applicationKey='+encodeURIComponent(config.sdkKey)),15000);
  const connected=await timeout(lib.connect(frame),20000);
  if(token!==tourSession)return;sdk=connected;
 }catch{if(token===tourSession){sdk=null;sdkEvidence={connected:false,state:'Connection failed',modelId:tour.id};showConnections(connectionRows);$('sdkStatus').textContent='SDK connection failed · use the standard viewer or open Matterport';$('playTour').title='The SDK connection did not complete';}return}
 subscribeTourRooms(sdk,token);
 document.querySelectorAll('[data-view]').forEach(b=>b.disabled=typeof sdk?.Mode?.moveTo!=='function');
 $('snapshotButton').disabled=typeof sdk?.Renderer?.takeScreenShot!=='function';
 await inspectConnectedSdk(sdk,{modelId:tour.id,withTimeout:timeout,isCurrent:()=>token===tourSession,onUpdate:updateSdkEvidence});
}
function defaultConnections(){return [{name:'CoStar catalog',state:'Ready',ok:true,detail:properties.length.toLocaleString()+' properties from the supplied snapshot.'},{name:'Matterport GraphQL',state:config.matterportConfigured?'Not checked':'Not configured',detail:'Model metadata and room data are checked on the server.'},{name:'Matterport SDK',state:config.sdkKey?'Check in tour':'Not configured',detail:'Open a 3D tour to test this domain and model with the SDK key.'},{name:'Vexcel aerial imagery',state:config.vexcelConfigured?'Not checked':'Not configured',detail:'Live imagery is enabled only after a successful imagery access check.'}]}
function showConnections(rows){
 connectionRows=rows;
 const resolved=rows.map(x=>x.name==='Matterport SDK'&&sdkEvidence?{name:x.name,ok:sdkEvidence.connected,state:sdkEvidence.connected?'Connected':sdkEvidence.state,detail:sdkEvidence.connected?'Browser SDK connection verified for model '+sdkEvidence.modelId+'. '+(sdkEvidence.guidedState==='ready'?sdkEvidence.stopCount+' saved guided-tour stops available.':sdkEvidence.guidedState==='empty'?'No saved guided tour on this model.':sdkEvidence.guidedState==='failed'?'Saved-tour discovery failed; camera controls remain connected.':'Checking saved-tour availability.'):'SDK '+sdkEvidence.state.toLowerCase()+' for model '+sdkEvidence.modelId+'.'}:(x.name.startsWith('Vexcel')&&aerialVerified.size?{name:'Vexcel imagery',ok:true,state:'Image access verified',detail:'Successfully displayed aerial imagery for '+aerialVerified.size+' viewed properties. Coverage is checked per location.'}:x));
 $('connectionResults').innerHTML=resolved.map(x=>'<div class="connection-row"><strong>'+escape(x.name)+'<span class="connection-pill '+(x.ok?'ok':'')+'">'+escape(x.state)+'</span></strong><p>'+escape(x.detail)+'</p></div>').join('');
}
async function checkConnections(){
 if(config.preview){showConnections(defaultConnections().map(x=>x.name==='CoStar catalog'?x:{...x,state:'Local preview',detail:'Run the server version with your environment keys to check live API access. Standard Matterport tours open directly.'}));return;}
 if(checking)return;checking=true;$('recheckButton').disabled=true;$('recheckButton').textContent='Checking…';
 try{const r=await fetch('/api/check',{method:'POST'});if(!r.ok)throw Error();const data=await r.json();showConnections(data.checks);document.querySelector('.status-dot').classList.toggle('connected',data.checks.some(x=>x.name==='Matterport GraphQL'&&x.ok));}
 catch{showConnections(defaultConnections().map(x=>x.name==='CoStar catalog'?x:{...x,state:'Check unavailable',detail:'The access check could not complete. Catalog comparison remains available.'}))}
 finally{checking=false;$('recheckButton').disabled=false;$('recheckButton').textContent='Check API access'}
}
function reset(){ $('city').value='Houston';$('beds').value='';$('budget').value='';$('query').value='';$('dogs').checked=false;$('parking').checked=false;$('sort').value='featured';visible=12;render()}
function exportComparison(){
 const csvCell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
 const rows=[['Property','Address','City','Floor plan','Bedrooms','Bathrooms','Area min (sq ft)','Area max (sq ft)','Asking rent min (USD/month)','Asking rent max (USD/month)','Reported units available','Dog policy','Parking','Tour URL','Snapshot date'],...entries().map(({property:p,plan})=>[p.name,p.address,p.city,plan.name,plan.beds,plan.baths,plan.sqftMin,plan.sqftMax,plan.rentMin,plan.rentMax,plan.available,petSummary(p),parkingSummary(p),'https://my.matterport.com/show/?m='+plan.tours[0].id,'2026-11-12'])];
 const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const link=document.createElement('a');const url=URL.createObjectURL(blob);link.href=url;link.download='homefit-comparison.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.close){$(button.dataset.close).close();return}
 if(button.hasAttribute('data-add')){toggleSelection(Number(button.dataset.add),Number(button.dataset.plan)||null);if($('detailDialog').open)detail(Number(button.dataset.add),Number(button.dataset.plan));return}
 if(button.hasAttribute('data-remove')){toggleSelection(Number(button.dataset.remove));return}
 if(button.hasAttribute('data-details')){detail(Number(button.dataset.details),Number(button.dataset.plan));return}
 if(button.hasAttribute('data-tour')){openTour(Number(button.dataset.tour),Number(button.dataset.plan));return}
 if(button.hasAttribute('data-room')){jumpToRoom(button.dataset.room);return}
 if(button.hasAttribute('data-view')){if(sdk)try{awaitView(button.dataset.view)}catch{}return}
 if(button.hasAttribute('data-explore'))showView('explore');
});
document.addEventListener('change',event=>{
 const target=event.target;
 const id=Number(target.dataset.planSelect||target.dataset.comparePlan||target.dataset.detailPlan);if(!id)return;
 const planId=Number(target.value);preferred[id]=planId;const s=selected.find(x=>x.propertyId===id);if(s){s.planId=planId;save()}
 if(target.dataset.detailPlan)detail(id,planId);render();if(currentView==='comparison')renderComparison();
});
for(const id of ['city','beds','budget','dogs','parking','sort'])$(id).addEventListener('change',()=>{visible=12;render()});
let searchTimer;$('query').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{visible=12;render()},150)});
$('reset').onclick=reset;$('emptyReset').onclick=reset;$('loadMore').onclick=()=>{visible+=12;render()};
$('browseNav').onclick=()=>showView('explore');$('backBrowse').onclick=()=>showView('explore');document.querySelector('.header .brand').onclick=e=>{e.preventDefault();showView('explore')};
$('compareNav').onclick=()=>showView('comparison');$('compareButton').onclick=()=>showView('comparison');$('clearSelection').onclick=()=>{selected=[];save();render()};$('exportButton').onclick=exportComparison;
$('connectionButton').onclick=()=>{$('connectionsDialog').showModal()};$('recheckButton').onclick=checkConnections;
$('aboutData').onclick=()=>$('dataDialog').showModal();
$('tourDialog').addEventListener('close',()=>{tourSession++;clearSdkRoomData();sdk=null;$('tourFrame').replaceChildren();});
$('panButton').onclick=async()=>{const active=sdk;if(!active)return;$('panButton').disabled=true;try{await active.Camera.rotate(90,0,{speed:20})}catch{toast('Camera movement is unavailable in the current view.')}finally{$('panButton').disabled=!sdk}};
$('playTour').onclick=async()=>{if(!sdk)return;try{await sdk.Tour.start(0)}catch{toast('The saved guided tour could not be started.')}};
$('snapshotButton').onclick=saveTourView;$('autoWalk').onclick=autoWalkthrough;
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
window.addEventListener('popstate',()=>showView(location.hash==='#compare'?'comparison':'explore'));
async function init(){
 $('cards').innerHTML='<div class="loading-card"></div>'.repeat(6);
 try{
  const results=window.HOMEFIT_CATALOG?[window.HOMEFIT_CATALOG,{preview:true}]:await Promise.all([fetch('/api/catalog').then(r=>{if(!r.ok)throw Error();return r.json()}),fetch('/api/config').then(r=>r.ok?r.json():{}).catch(()=>({}))]);
  properties=results[0].properties;config=results[1];properties.forEach(p=>propertyMap.set(p.id,p));
  let restored=[];const shared=new URLSearchParams(location.search).get('compare');
  if(shared)restored=shared.split(',').map(x=>{const [propertyId,planId]=x.split(':').map(Number);return {propertyId,planId}});
  else{try{restored=JSON.parse(localStorage.getItem('homefit-shortlist-v1')||'[]')}catch{}}
  selected=normalizeSelections(restored,properties);for(const x of selected)preferred[x.propertyId]=x.planId;
  render();showConnections(defaultConnections());showView(location.hash==='#compare'?'comparison':'explore');
  renderCoverageBanner();
  if(config.vexcelConfigured&&!config.preview)checkCatalogCoverage();
  if(config.matterportConfigured||config.vexcelConfigured)checkConnections();
 }catch{$('cards').innerHTML='<div class="empty"><h2>The catalog couldn’t load.</h2><p>Please refresh the page to try again.</p><button class="primary" id="retryCatalog">Try again</button></div>';$('resultCount').textContent='Catalog unavailable';$('retryCatalog').onclick=init;}
}
/*__LIVE__*/
init();
