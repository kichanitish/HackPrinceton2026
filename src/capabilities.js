let scanSubscriptions=[],scanViews=[],scanCurrentView=null,scanFeatureFlags={},scanMeasurementActive=false,scanMeasureState='unverified',scanReady=false,scanTourState='checking',scanMeasurementCount=null,scanViewState='unverified',scanSettings={};
function clearScanCapabilities(){
 for(const subscription of scanSubscriptions)try{subscription?.cancel?.()}catch{}
 scanSubscriptions=[];scanViews=[];scanCurrentView=null;scanFeatureFlags={};scanMeasurementActive=false;scanMeasureState='unverified';scanReady=false;scanTourState='checking';scanMeasurementCount=null;scanViewState='unverified';scanSettings={};
 $('scanTools').hidden=true;$('scanCapabilities').open=false;$('scanCapabilityRows').replaceChildren();$('defurnishButton').hidden=true;$('measureButton').hidden=true;$('publishedViewField').hidden=true;
 $('scanControlNote').textContent='Matterport’s toolbar and menu remain available inside the viewer.';
}
function observeScan(observable,observer){if(!observable?.subscribe)return false;try{scanSubscriptions.push(observable.subscribe(observer));return true}catch{return false}}
function subscribeScanCapabilities(connected,token){
 const current=()=>token===tourSession&&sdk===connected;
 const update=()=>{if(current())renderScanCapabilities()};
 observeScan(connected.App?.features,flags=>{if(!current())return;scanFeatureFlags=flags||{};update()});
 observeScan(connected.App?.state,state=>{if(!current())return;scanReady=state.phase==='appphase.playing';update()});
 observeScan(connected.View?.views,{onCollectionUpdated:collection=>{if(!current())return;scanViews=availablePublishedViews(collection);scanViewState='available';update()}});
 observeScan(connected.View?.current,view=>{if(!current())return;scanCurrentView=view||null;update();if(scanReady)loadScanSettings(connected,token)});
 observeScan(connected.Measurements?.mode,state=>{if(!current())return;scanMeasurementActive=state.active===true;update()});
 observeScan(connected.Measurements?.data,{onCollectionUpdated:collection=>{if(!current())return;scanMeasurementCount=Object.keys(collection||{}).length;update()}});
 scanMeasureState=typeof connected.Measurements?.toggleMode==='function'?'available':'unverified';
 $('scanTools').hidden=false;update();
}
function renderScanCapabilities(){
 if(!sdk)return;
 const views=visibleScanViews(),pair=defurnishPair(views),defurnished=scanCurrentView?.type==='viewtype.defurnish';
 const defurnishFlag=featureAvailability(scanFeatureFlags['feature.defurnish']);
 $('defurnishButton').hidden=!pair;
 $('defurnishButton').disabled=!scanReady;
 $('defurnishButton').textContent=defurnished?'Show original furniture':'Remove scanned furniture';
 $('defurnishButton').setAttribute('aria-pressed',String(defurnished));
 $('measureButton').hidden=scanMeasureState!=='available'||scanSettings.measurements===false;$('measureButton').disabled=!scanReady;
 $('measureButton').textContent=scanMeasurementActive?'Finish measuring':'Measure manually';$('measureButton').setAttribute('aria-pressed',String(scanMeasurementActive));
 const select=$('publishedView'),values=views.map(v=>v.id+'|'+v.name).join(';');
 if(select.dataset.options!==values){select.innerHTML=views.map((v,i)=>'<option value="'+escape(v.id)+'">'+escape(v.name||(v.type==='viewtype.defurnish'?'Defurnished view':'View '+(i+1)))+'</option>').join('');select.dataset.options=values}
 if(scanCurrentView)select.value=scanCurrentView.id;
 select.disabled=!scanReady;$('publishedViewField').hidden=views.length<2;
 $('playTour').hidden=scanSettings.tour_buttons===false;
 const rows=[];
 const add=(name,state,detail)=>rows.push({name,state,detail});
 add('Furniture removal',pair?'Available':defurnishFlag==='available'?'In viewer':defurnishFlag==='unavailable'?'Not available':'Unverified',pair?'Switch between the original and published defurnished views.':defurnishFlag==='available'?'Use Matterport’s Hide Furniture control inside the viewer.':defurnishFlag==='unavailable'?'Matterport reports this feature unavailable in the current view.':'Matterport has not confirmed availability. Check the native toolbar and menu.');
 add('Navigation modes','3D tour', ['floor_plan','dollhouse'].map(key=>(key==='floor_plan'?'Floor plan':'Dollhouse')+(scanSettings[key]===false?' not published':scanSettings[key]===true?' enabled':' availability unverified')).join(' · '));
 add('Manual ruler',scanSettings.measurements===false?'Not published':scanMeasureState==='available'?'Available':scanMeasureState==='unavailable'?'Not available':'Unverified',scanSettings.measurements===false?'The publisher disabled manual measurement controls.':scanMeasureState==='available'?'Choose points to measure distances yourself.'+(scanMeasurementCount===0?' No ruler lines are loaded; the room dimensions below are separate data.':scanMeasurementCount!==null?' '+scanMeasurementCount+' ruler measurements currently loaded.':''):'Measurement controls could not be confirmed for this view.');
 const model=activeModelData?.ok?activeModelData.model:null,rooms=model?.rooms?.filter(usableRoom)||[],measured=rooms.filter(r=>measuredArea(r.dimensions)||r.dimensions?.width>0&&r.dimensions?.depth>0);
 add('Room dimension data',measured.length?'Available':activeModelData?'Not returned':'Checking',measured.length?measured.length+' of '+rooms.length+' room records have dimensions, listed below. These are not saved ruler lines or a promise of labels inside the viewer.':'Scan dimensions are separate from the manual ruler; missing data is not estimated.');
 add('Published views',scanViewState==='available'?(views.length?views.length+' loaded':'None returned'):'Unverified','Native view selection remains available when published by the owner.');
 add('Saved guided tour',scanSettings.tour_buttons===false?'Not published':scanTourState==='ready'?'Available':scanTourState==='empty'?'None returned':scanTourState==='failed'?'Unverified':'Checking',scanSettings.tour_buttons===false?'The publisher disabled guided-tour controls.':scanTourState==='failed'?'SDK discovery did not confirm saved stops. Try guided tour, or use a play control in Matterport.':'Publisher-authored stops are separate from HomeFit’s automatic room walkthrough.');
 add('3D furniture studio',sdk.Scene?.createObjects?'Available':'Open studio',sdk.Scene?.createObjects?'This viewer exposes Bundle SDK scene access.':'Furnish in 3D opens the Bundle viewer for this scan.');
 $('scanCapabilityRows').innerHTML=rows.map(row=>'<div class="scan-capability"><strong>'+escape(row.name)+'<span>'+escape(row.state)+'</span></strong><p>'+escape(row.detail)+'</p></div>').join('');
 $('scanControlNote').textContent='Matterport’s toolbar and menu retain the scan’s published tools, including tags, floor selection, sharing and fullscreen where supported.';
}
$('measureButton').onclick=async()=>{
 const connected=sdk,session=tourSession;if(!connected?.Measurements?.toggleMode)return;
 $('measureButton').disabled=true;
 try{await connected.Measurements.toggleMode(!scanMeasurementActive)}catch{if(session===tourSession){scanMeasureState='unavailable';toast('Measurement mode is unavailable in this view. Check the Matterport toolbar.')}}
 finally{if(session===tourSession)renderScanCapabilities()}
};
async function activatePublishedView(view){
 if(!view||!sdk)return;const session=tourSession;
 try{await view.setActive(false);if(session!==tourSession)return;scanMeasureState=typeof sdk.Measurements?.toggleMode==='function'?'available':'unverified';renderScanCapabilities()}
 catch{if(session===tourSession)toast('This published view could not be opened. Try the native Matterport view selector.')}
}
$('defurnishButton').onclick=()=>{const pair=defurnishPair(visibleScanViews());if(pair)activatePublishedView(scanCurrentView?.type==='viewtype.defurnish'?pair.furnished:pair.empty)};
$('publishedView').onchange=event=>activatePublishedView(visibleScanViews().find(v=>v.id===event.target.value));
$('scanSelect').onchange=event=>{if(tourContext)openTour(tourContext.propertyId,tourContext.planId,tourContext.furnish,event.target.value)};

function visibleScanViews(){return scanViews.filter(view=>view.type!=='viewtype.defurnish'||scanSettings.defurnish_view!==false&&scanFeatureFlags['feature.defurnish']!==false)}
async function loadScanSettings(connected,token){
 const settings=await timeout(scanDisplaySettings(connected),5000).catch(()=>({}));if(token!==tourSession||sdk!==connected)return;scanSettings=settings;renderScanCapabilities();
}
