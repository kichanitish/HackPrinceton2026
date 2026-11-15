function isCommercial(p){return p?.mode==='commercial'}
function commercialPrice(plan){return plan.rentMin>0?money(Math.round(plan.rentMin))+'<small>/mo est.</small>':'Ask for rent'}
function commercialRate(plan){return plan.annualRateMin>0?money(plan.annualRateMin)+'/sq ft/year · '+escape((plan.serviceType||'Lease terms unreported').replace(/([a-z])([A-Z])/g,'$1 $2')):'Asking rate not reported'}
function spaceActions(p,plan){return '<div class="table-actions">'+(plan.tours?.length?'<button class="secondary" data-tour="'+p.id+'" data-plan="'+plan.id+'">'+tourIcon+'3D tour</button>':'<span class="muted">3D scan not provided</span>')+'</div>'}
function commercialCard(p,plan,plans,checked){
 return '<article class="card '+(checked?'selected':'')+'"><div class="card-media"><button class="card-image-link" data-details="'+p.id+'" data-plan="'+plan.id+'" aria-label="View details for '+escape(p.name)+'">'+photo(p)+'</button><button class="select-round" data-add="'+p.id+'" data-plan="'+plan.id+'" aria-label="'+(checked?'Remove from shortlist: ':'Add to shortlist: ')+escape(p.name)+'" aria-pressed="'+checked+'">'+(checked?'✓':'+')+'</button>'+(plan.tours.length?'<button class="tour-badge" data-tour="'+p.id+'" data-plan="'+plan.id+'">'+tourIcon+'Explore in 3D</button>':'')+'</div><div class="card-content"><div class="card-topline"><span class="city-label">'+escape(p.city)+'</span><span class="availability">'+escape(plan.use)+'</span></div><h3>'+escape(p.name)+'</h3><p class="card-address">'+escape(p.address)+', '+escape(p.zip)+'</p><label class="plan-field"><span>Available spaces</span><select class="plan-select" data-plan-select="'+p.id+'">'+planOptions(plans,plan)+'</select></label><div class="plan-facts"><span>'+sqftText(plan)+'</span><span>'+escape(plan.floorLabel)+'</span></div><div class="card-bottom"><div class="rent">'+commercialPrice(plan)+'<span class="rent-sub">Estimated base rent · charges extra</span></div><button class="details-link" data-details="'+p.id+'" data-plan="'+plan.id+'">View details ↗</button></div></div></article>';
}
function businessContextMarkup(p,plan){
 const c=p.businessContext||{},facts=[];
 if(c.officeBuildings>0)facts.push(number(c.officeBuildings)+' office buildings recorded within 0.5 mile.');
 if(c.nearbyApartmentUnits>0)facts.push(number(c.nearbyApartmentUnits)+' apartment units recorded within 0.5 mile.');
 if(c.recordedWorkers>0)facts.push(number(c.recordedWorkers)+' employees associated with tenant company profiles within 0.5 mile; this is not verified on-site staffing.');
 if(plan.rentBenchmark){const b=plan.rentBenchmark;facts.push('Historical signed-rent median: '+money(b.medianAnnualRate)+'/sq ft/year across '+b.n+' same-use, same-service-type records since '+b.sinceYear+'. These may differ in location, size and condition.')}
 return '<details class="business-context"><summary>Business context</summary>'+(facts.length?facts.map(x=>'<p>'+escape(x)+'</p>').join(''):'<p>Nearby business and rent evidence is not reported for this property.</p>')+'<p>Snapshot evidence is incomplete. It does not establish foot traffic, demand, revenue, zoning or permitted use.</p></details>';
}
function commercialDetail(p,plan){
 $('detailContent').innerHTML='<div class="detail-image">'+photo(p,'',false)+'<button class="icon-button" data-close="detailDialog" aria-label="Close property details">×</button></div><div class="detail-body"><span class="city-label">BUSINESS SPACE · '+escape(p.city)+'</span><h2>'+escape(p.name)+'</h2><p class="detail-address">'+escape(p.address)+', '+escape(p.city)+', '+escape(p.state)+'</p><div class="detail-facts"><div><span>ESTIMATED BASE RENT</span><strong>'+commercialPrice(plan)+'</strong></div><div><span>SPACE USE</span><strong>'+escape(plan.use)+'</strong></div><div><span>REPORTED SIZE</span><strong>'+sqftText(plan)+'</strong></div><div><span>LEVEL</span><strong>'+escape(plan.floorLabel)+'</strong></div></div><label class="plan-field"><span>Available spaces</span><select class="plan-select" data-detail-plan="'+p.id+'">'+planOptions(p.plans,plan)+'</select></label><p class="commercial-rate">'+commercialRate(plan)+'</p><div class="detail-actions">'+spaceActions(p,plan)+'<button class="secondary" data-add="'+p.id+'" data-plan="'+plan.id+'">'+(selected.some(x=>x.propertyId===p.id)?'Remove from shortlist':'Add to shortlist')+'</button></div>'+(plan.notes?'<h3>From the listing</h3><p class="listing-notes">'+escape(plan.notes)+'</p>':'')+(plan.floorplan?'<p><a class="text-button" target="_blank" rel="noopener noreferrer" href="'+escape(plan.floorplan)+'">View listed floor plan ↗</a></p>':'')+businessContextMarkup(p,plan)+contactDetails(p)+'<h3>Parking</h3><p>'+escape(parkingSummary(p))+'</p><p class="source-note">CoStar property #'+p.sourceId+' · Space #'+plan.id+' · November 12, 2026.<br>Estimated monthly base rent = quoted annual rate × minimum reported area ÷ 12. Charges, exact leasable area, availability, fit-out, zoning and permits must be confirmed. A building scan may depict a different suite.</p></div>';
 attachImageFallbacks($('detailDialog'));if(!$('detailDialog').open)$('detailDialog').showModal();renderDetailLive(p,plan);
}
function commercialComparison(items){
 $('comparisonSubtitle').textContent=items.length===1?'Your selected space. Add another property whenever you’re ready.':'Your selected properties and spaces, side by side.';
 const row=(label,fn)=>'<tr><th scope="row">'+label+'</th>'+items.map(x=>'<td>'+fn(x)+'</td>').join('')+'</tr>';
 let html='<div class="compare-scroll '+(items.length===1?'single':'')+'"><table class="comparison-table '+(items.length===1?'one':items.length===2?'two':'')+'"><caption class="sr-only">Shortlisted properties and available spaces</caption><thead><tr><th>THE SHORTLIST</th>'+items.map(({property:p,plan})=>'<th><button class="shortlist-image-link" data-details="'+p.id+'" data-plan="'+plan.id+'" aria-label="View details for '+escape(p.name)+'">'+photo(p,'compare-photo',false)+'</button><span class="city-label">'+escape(p.city)+' · '+(isCommercial(p)?'Business':'Home')+'</span><h2 class="compare-property-name">'+escape(p.name)+'</h2><span class="muted">'+escape(p.address)+'</span><label class="plan-field"><span>'+(isCommercial(p)?'Available spaces':'Available floor plans')+'</span><select class="plan-select" data-compare-plan="'+p.id+'">'+planOptions(p.plans,plan)+'</select></label>'+spaceActions(p,plan)+'<button class="text-button" data-remove="'+p.id+'">Remove</button>'+matchColumnMarkup(p,plan)+'</th>').join('')+'</tr></thead><tbody>';
 html+=row('ASKING RENT',({property:p,plan})=>'<div class="rent">'+(isCommercial(p)?commercialPrice(plan):rentText(plan)+'<small>/mo</small>')+'</div><span class="rent-sub">'+(isCommercial(p)?'Estimate from minimum area · charges extra':'Whole-unit asking rent · fees extra')+'</span>');
 html+=row('PLAN / SPACE',({property:p,plan})=>escape(plan.name)+'<br><span class="muted">'+(isCommercial(p)?escape(plan.use)+' · '+escape(plan.floorLabel):bedsText(plan.beds)+' · '+number(plan.baths)+' bath')+'</span>');
 html+=row('REPORTED AREA',({plan})=>sqftText(plan));
 html+=row('LEASE BASIS',({property:p,plan})=>isCommercial(p)?commercialRate(plan):'Whole apartment · monthly asking rent');
 html+=row('OWNER',({property:p})=>contactSummary(p,'owner'));
 html+=row('MANAGEMENT',({property:p})=>contactSummary(p,'management'));
 html+=row('LEASING CONTACT',({property:p})=>contactSummary(p,'leasing'));
 html+=row('PARKING',({property:p})=>escape(parkingSummary(p)));
 html+=row('BUILDING',({property:p,plan})=>escape(p.style)+(isCommercial(p)?businessContextMarkup(p,plan):''));
 html+='</tbody></table></div><p class="source-note">CoStar snapshot · November 12, 2026. Commercial monthly amounts are estimates from quoted rate and minimum reported area; charges and permitted use remain unverified.</p>';
 $('comparisonContent').innerHTML=html;attachImageFallbacks($('comparisonContent'));renderCompareLive(items);
}
function setBrowsePurpose(mode){
 $('purpose').value=mode;
 $('explore').dataset.mode=mode;
 updateNeedsMode(mode);
 $('introTitle').innerHTML=mode==='commercial'?'Space for business.<br><em>See the possibilities.</em>':'Find a place.<br><em>See how it fits.</em>';
 $('introDescription').textContent=mode==='commercial'?'Explore spaces, lease terms and the context around your next location.':'Explore the details that matter, then step inside. Real floor plans. Clear prices. A closer look.';
 $('resultsTitle').textContent=mode==='commercial'?'Room for your next venture':'Your next chapter starts here';
 document.querySelectorAll('[data-home-filter]').forEach(node=>node.hidden=mode==='commercial');document.querySelectorAll('[data-business-filter]').forEach(node=>node.hidden=mode!=='commercial');
 $('homesPurpose').setAttribute('aria-pressed',String(mode==='home'));$('businessPurpose').setAttribute('aria-pressed',String(mode==='commercial'));
 visible=12;render();updateURL();
}
function updateMatchMode(){
 const commercial=$('matchMode').value==='commercial';document.querySelectorAll('[data-home-match]').forEach(node=>node.hidden=commercial);document.querySelectorAll('[data-business-match]').forEach(node=>node.hidden=!commercial);
 $('matchBudget').max=commercial?'200000':'20000';
 $('matchNeeds').placeholder=commercial?'Your business, preferred location, space needs, or fit-out priorities…':'Room for two desks, a larger bedroom, or keeping rent as low as possible…';
}
$('homesPurpose').onclick=()=>{if(matchController)cancelPersonalMatches();setBrowsePurpose('home')};$('businessPurpose').onclick=()=>{if(matchController)cancelPersonalMatches();setBrowsePurpose('commercial')};
$('matchMode').onchange=updateMatchMode;
function populateBusinessOptions(){for(const [key,p] of Object.entries(BUSINESS_PROFILES)){const option=document.createElement('option');option.value=key;option.textContent=p.label;$('businessType').append(option)}}
for(const id of ['businessType','minArea','maxArea'])$(id).addEventListener('change',()=>{visible=12;render()});
