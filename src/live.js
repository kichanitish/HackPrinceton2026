async function loadModel(id){
 if(liveModelCache.has(id))return liveModelCache.get(id);
 if(config.preview)return {ok:false,state:'Server required'};
 if(!liveModelJobs.has(id))liveModelJobs.set(id,fetch('/api/model?id='+encodeURIComponent(id)).then(r=>r.json()).catch(()=>({ok:false,state:'Connection failed'})).then(result=>{liveModelCache.set(id,result);liveModelJobs.delete(id);return result}));
 return liveModelJobs.get(id);
}
function measuredArea(d){if(!(d?.areaFloorIndoor>0))return null;return d.units==='imperial'?d.areaFloorIndoor:d.units==='metric'?d.areaFloorIndoor*10.7639104167:null}
function areaText(d){const area=measuredArea(d);return area?Math.round(area).toLocaleString('en-US')+' sq ft':null}
function roomFacts(room){const d=room.dimensions;const parts=[];if(areaText(d))parts.push(areaText(d));if(d?.width>0&&d?.depth>0){const unit=d.units==='imperial'?'ft':d.units==='metric'?'m':null;if(unit)parts.push(Number(d.width).toFixed(1)+' × '+Number(d.depth).toFixed(1)+' '+unit)}return parts.join(' · ')||'Dimensions not reported'}
function usableRoom(room){return normalizeRoomName(room.label)!=='void'}
function clearSdkRoomData(){walkRun++;sdkRooms=[];sdkSweeps=[];activeModelData=null;for(const s of sdkSubscriptions)try{s.cancel?.()}catch{}sdkSubscriptions=[];$('autoWalk').textContent='Auto walkthrough'}
function subscribeTourRooms(connected,token){
 const current=()=>token===tourSession;
 if(connected.Room?.data?.subscribe)try{sdkSubscriptions.push(connected.Room.data.subscribe({onCollectionUpdated:rooms=>{if(!current())return;sdkRooms=Object.values(rooms).filter(usableRoom);renderTourRooms()}}))}catch{}
 if(connected.Sweep?.data?.subscribe)try{sdkSubscriptions.push(connected.Sweep.data.subscribe({onCollectionUpdated:sweeps=>{if(!current())return;sdkSweeps=Object.values(sweeps);renderTourRooms()}}))}catch{}
}
function renderTourRooms(){
 const model=activeModelData?.ok?activeModelData.model:null;
 $('modelArea').textContent=areaText(model?.dimensions)?areaText(model.dimensions)+' captured indoor area':'';
 const rooms=model?.rooms?.length?model.rooms.filter(usableRoom):sdkRooms;
 if(!rooms.length){$('roomStatus').textContent=activeModelData?.ok?'Room records are not available for this scan.':config.preview?'Run the server version to load live room measurements.':'Room metadata is unavailable for this scan. You can still explore the viewer.';$('roomList').replaceChildren();return}
 $('roomStatus').textContent=rooms.length+' room records · select an enabled room to move there. Measurements come from the captured scan.';
 $('roomList').innerHTML=rooms.map((room,index)=>{
  const spatial=sdkRooms.find(r=>r.id===room.id)||matchingRoom(sdkRooms,room.label),target=spatial&&sweepForRoom(spatial,sdkSweeps);
  return '<button class="room-tile" data-room="'+escape(spatial?.id||room.id)+'" '+(!target?'disabled':'')+'><strong>'+escape(room.label||'Room '+(index+1))+'</strong><span>'+escape(roomFacts(room))+'</span></button>';
 }).join('');
 $('autoWalk').disabled=!sdk||sdkRooms.filter(r=>sweepForRoom(r,sdkSweeps)).length<2;
}
async function jumpToRoom(id){
 const room=sdkRooms.find(r=>r.id===id),sweep=room&&sweepForRoom(room,sdkSweeps),connected=sdk;
 if(!connected||!sweep)return;
 try{
  await connected.Sweep.moveTo(sweep.id,{transition:connected.Camera?.TransitionType?.FLY||'transition.fly',transitionTime:1000});
  if(connected===sdk&&typeof connected.Camera.lookAt==='function'){
   const target={x:room.center.x,y:sweep.position.y,z:room.center.z};
   if(Math.hypot(target.x-sweep.position.x,target.z-sweep.position.z)<.35)target.x=room.bounds.max.x;
   await connected.Camera.lookAt(target);
  }
 }catch{toast('This room could not be reached from the current scan view.')}
}
async function awaitView(mode){if(!sdk)return;try{await sdk.Mode.moveTo(sdk.Mode.Mode?.[mode]||'mode.'+mode.toLowerCase())}catch{toast('That view is not available for this scan.')}}
async function saveTourView(){
 const connected=sdk;if(!connected)return;$('snapshotButton').disabled=true;
 try{const uri=await connected.Renderer.takeScreenShot({width:1600,height:1000},{mattertags:false,measurements:false,sweeps:false,views:false});if(connected!==sdk)return;const a=document.createElement('a');a.href=uri;a.download='homefit-interior-view.jpg';a.click();toast('Saved the current Matterport view.')}catch{toast('This view could not be saved.')}finally{$('snapshotButton').disabled=!sdk?.Renderer?.takeScreenShot}
}
async function autoWalkthrough(){
 if($('autoWalk').textContent==='Stop walkthrough'){walkRun++;$('autoWalk').textContent='Auto walkthrough';return}
 if(!sdk)return;const run=++walkRun,session=tourSession;
 const rooms=sdkRooms.filter(r=>sweepForRoom(r,sdkSweeps));$('autoWalk').textContent='Stop walkthrough';
 for(const room of rooms){
  if(run!==walkRun||session!==tourSession)break;
  await jumpToRoom(room.id);if(run!==walkRun||session!==tourSession)break;
  $('roomStatus').textContent='Auto walkthrough · '+(room.label||'Room')+' · uses captured scan positions';
  await new Promise(resolve=>setTimeout(resolve,1800));
 }
 if(session===tourSession){$('autoWalk').textContent='Auto walkthrough';renderTourRooms()}
}
function modelSummary(result){
 if(!result.ok)return '<span class="muted">'+escape(result.state||'Unavailable')+' · room measurements not loaded</span>';
 const m=result.model,rooms=m.rooms.filter(usableRoom);return (areaText(m.dimensions)?'<strong>'+areaText(m.dimensions)+' captured indoor area</strong><br>':'')+'<span class="muted">'+rooms.length+' room records · captured scan</span>'+rooms.filter(r=>areaText(r.dimensions)).slice(0,8).map((r,i)=>'<div class="room-compare-line">'+escape(r.label||'Room '+(i+1))+' <strong>'+areaText(r.dimensions)+'</strong></div>').join('');
}
function renderCompareLive(items){
 const tbody=$('comparisonContent').querySelector('tbody');if(!tbody)return;
 const row=document.createElement('tr');row.innerHTML='<th scope="row">MATTERPORT INTERIOR</th>'+items.map(({property:p,plan})=>'<td><div id="modelCompare'+p.id+'" data-model="'+escape(plan.tours[0].id)+'" class="live-summary">Loading measured room data…</div></td>').join('');tbody.insertBefore(row,tbody.rows[3]||null);
 for(const {property:p,plan} of items)loadModel(plan.tours[0].id).then(result=>{const node=$('modelCompare'+p.id);if(node?.dataset.model===plan.tours[0].id)node.innerHTML=modelSummary(result)});
 renderCompareAerial(items,tbody);
}
function renderDetailLive(p,plan){
 const body=$('detailContent').querySelector('.detail-body');if(!body)return;
 const section=document.createElement('section');section.className='live-data-section';section.innerHTML='<h3>Measured interior</h3><div id="detailModel" data-model="'+escape(plan.tours[0].id)+'" class="live-summary">Loading Matterport room details…</div><p>These dimensions describe the scan, which may be a representative unit. They are separate from the listing’s reported floor area.</p>';body.insertBefore(section,[...body.children].find(x=>x.tagName==='H3')||null);
 loadModel(plan.tours[0].id).then(result=>{const node=$('detailModel');if(node?.dataset.model===plan.tours[0].id)node.innerHTML=modelSummary(result)});
 renderDetailAerial(p,body);
}
let aerialCache=new Map(),aerialJobs=new Map(),aerialVerified=new Set(),auditSummary=null;
async function loadCoverage(p){
 if(aerialCache.has(p.id))return aerialCache.get(p.id);
 if(config.preview)return {ok:false,state:'Server required'};
 if(!aerialJobs.has(p.id))aerialJobs.set(p.id,fetch('/api/coverage?id='+p.id).then(r=>r.json()).catch(()=>({ok:false,state:'Connection failed'})).then(r=>{if(r.ok)aerialCache.set(p.id,r);aerialJobs.delete(p.id);return r}));
 return aerialJobs.get(p.id);
}
function captureWindow(c){const first=c.firstCapture?.slice(0,10),last=c.lastCapture?.slice(0,10);return first&&last?first===last?first:first+' to '+last:first||last||'Capture dates not reported'}
function preferredCollection(coverage){return coverage.collections.find(c=>c.layer==='urban')||coverage.collections[0]}
function imageUrl(id,collection,context=false){return '/api/aerial?id='+id+'&collection='+encodeURIComponent(collection.id)+(context?'&context=1':'')}
function imageryLoaded(p){aerialVerified.add(p.id);showConnections(connectionRows);renderCoverageBanner()}
function imageryError(img){const p=document.createElement('p');p.className='live-loading';p.textContent='Coverage was found, but image retrieval failed. Try another collection.';img.replaceWith(p)}
function aerialMarkup(p,coverage,compact=false){
 if(!coverage.ok)return '<p class="live-loading">Vexcel imagery: '+escape(coverage.state||'Unavailable')+'.</p>';
 if(!coverage.available)return '<p class="live-loading">No urban or wide-area imagery collections were returned for this location.</p>';
 const selected=preferredCollection(coverage);
 return '<img class="'+(compact?'compare-aerial':'aerial-image')+'" data-vexcel-image="'+p.id+'" src="'+imageUrl(p.id,selected)+'" alt="Vexcel aerial imagery centered on '+escape(p.name)+'"><div class="aerial-meta"><label>Collection <select data-aerial-collection="'+p.id+'">'+coverage.collections.map(c=>'<option value="'+escape(c.id)+'" '+(c===selected?'selected':'')+'>'+escape(captureWindow(c))+' · '+escape(c.layer)+'</option>').join('')+'</select></label></div><p class="live-summary" data-aerial-caption>Collection capture window: '+escape(captureWindow(selected))+(selected.gsd?' · '+(selected.gsd*100).toFixed(1)+' cm source imagery':'')+'. © Vexcel Imaging.</p>'+(compact?'':'<label class="chip"><input type="checkbox" data-aerial-context="'+p.id+'">Wider surroundings</label><p class="aerial-location-note">The crosshair marks the property’s recorded coordinate, not a specific apartment. Capture dates describe the collection window; individual image pixels may differ. Imagery does not establish current condition, noise or safety.</p>');
}
function bindAerialImages(root){root.querySelectorAll('[data-vexcel-image]').forEach(img=>{img.addEventListener('load',()=>imageryLoaded(propertyMap.get(Number(img.dataset.vexcelImage))),{once:true});img.addEventListener('error',()=>imageryError(img),{once:true})})}
function renderCompareAerial(items,tbody){
 const row=document.createElement('tr');row.innerHTML='<th scope="row">SITE & SURROUNDINGS</th>'+items.map(({property:p})=>'<td><div id="aerialCompare'+p.id+'" class="aerial-block"><p class="live-loading">Checking aerial imagery…</p></div></td>').join('');tbody.insertBefore(row,[...tbody.rows].find(r=>r.querySelector('th')?.textContent==='BUILDING')||null);
 for(const {property:p} of items)loadCoverage(p).then(coverage=>{const node=$('aerialCompare'+p.id);if(node){node.innerHTML=aerialMarkup(p,coverage,true);bindAerialImages(node)}});
}
function renderDetailAerial(p,body){
 const section=document.createElement('section');section.className='live-data-section aerial-block';section.id='detailAerial';section.dataset.property=p.id;section.innerHTML='<h3>Site & surroundings</h3><p class="live-loading">Checking Vexcel imagery at this location…</p>';body.insertBefore(section,[...body.children].find(x=>x.tagName==='H3')||null);
 loadCoverage(p).then(coverage=>{const node=$('detailAerial');if(node?.dataset.property===String(p.id)){node.innerHTML='<h3>Site & surroundings</h3>'+aerialMarkup(p,coverage);bindAerialImages(node)}});
}
document.addEventListener('change',event=>{
 const target=event.target,id=Number(target.dataset.aerialCollection||target.dataset.aerialContext);if(!id)return;
 const block=target.closest('.aerial-block'),coverage=aerialCache.get(id);if(!block||!coverage)return;
 const chosen=coverage.collections.find(c=>c.id===block.querySelector('[data-aerial-collection]')?.value);if(!chosen)return;
 const context=!!block.querySelector('[data-aerial-context]')?.checked;
 let img=block.querySelector('[data-vexcel-image]');if(!img){img=document.createElement('img');img.className=block.id.startsWith('aerialCompare')?'compare-aerial':'aerial-image';img.dataset.vexcelImage=id;img.alt='Vexcel imagery of '+propertyMap.get(id).name;block.querySelector('.live-loading')?.replaceWith(img)}
 img.src=imageUrl(id,chosen,context);bindAerialImages(block);
 block.querySelector('[data-aerial-caption]').textContent='Collection capture window: '+captureWindow(chosen)+(chosen.gsd?' · '+(chosen.gsd*100).toFixed(1)+' cm source imagery':'')+'. © Vexcel Imaging.';
});
function renderCoverageBanner(){
 let banner=$('coverageBanner');if(!banner){banner=document.createElement('div');banner.id='coverageBanner';banner.className='coverage-banner';document.querySelector('.results-heading').before(banner)}
 if(config.preview){banner.innerHTML='<span>Live interior measurements and aerial imagery are available in the server version.</span>';return}
 if(!config.vexcelConfigured){banner.hidden=true;return}
 if(!auditSummary){banner.innerHTML='<span>Vexcel aerial imagery · coverage is checked at each property location.</span><button class="text-button" id="auditButton">Check catalog coverage ↗</button>';const b=$('auditButton');if(b)b.onclick=checkCatalogCoverage;return}
 banner.innerHTML='<span><strong>Vexcel aerial coverage: '+auditSummary.covered.toLocaleString()+' / '+auditSummary.total.toLocaleString()+' catalog locations</strong><br>'+auditSummary.cities.map(c=>escape(c.city)+': '+c.covered+'/'+c.total).join(' · ')+' · Based on collection footprints.'+(aerialVerified.size?' Image retrieval verified for '+aerialVerified.size+' viewed '+(aerialVerified.size===1?'property.':'properties.'):'')+'</span><button class="text-button" id="auditButton">Recheck ↗</button>';
 $('auditButton').onclick=checkCatalogCoverage;
}
async function checkCatalogCoverage(){
 if(config.preview||!config.vexcelConfigured)return;const button=$('auditButton');if(button){button.disabled=true;button.textContent='Checking…'}
 try{const response=await fetch('/api/coverage-audit');const result=await response.json();if(!result.ok)throw Error();auditSummary=result;renderCoverageBanner()}catch{if(button){button.disabled=false;button.textContent='Try coverage check again'}toast('Catalog coverage could not be checked. Individual properties can still be checked.')}
}
