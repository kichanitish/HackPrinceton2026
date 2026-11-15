function contactGroup(role){return ['Owner','Recorded owner','Owner listing contact'].includes(role)?'owner':role==='Property manager'?'management':'leasing'}
function propertyContacts(p){
 const contacts=Array.isArray(p.contacts)?p.contacts:[];
 if(!contacts.length&&p.manager&&!isCommercial(p))return [{role:'Property manager',company:p.manager}];
 return contacts;
}
function contactMarkup(c){
 const phone=String(c.phone||''),digits=phone.replace(/\D/g,''),code=String(c.countryCode||'').replace(/\D/g,'');
 const dial=digits?(phone.trim().startsWith('+')?'+'+digits:code&&!digits.startsWith(code)?'+'+code+digits:digits):'';
 const extension=String(c.extension||'').replace(/\D/g,'');
 const email=String(c.email||'').trim();
 return '<div class="property-contact"><span class="contact-role">'+escape(c.role)+'</span>'+(c.name?'<strong>'+escape(c.name)+'</strong>':'')+(c.company?'<span>'+escape(c.company)+'</span>':'')+(dial?'<a href="tel:'+dial+(extension?';ext='+extension:'')+'">'+escape(phone)+(extension?' ext. '+escape(extension):'')+(c.phoneKind==='Company'?' <small>(company line)</small>':'')+'</a>':'')+(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)?'<a href="mailto:'+escape(encodeURIComponent(email).replace(/%40/g,'@'))+'">'+escape(email)+'</a>':'')+'</div>';
}
function contactSummary(p,group){
 const contacts=propertyContacts(p).filter(c=>contactGroup(c.role)===group);
 if(!contacts.length)return '<span class="muted">Not reported</span>';
 return contacts.slice(0,2).map(contactMarkup).join('')+(contacts.length>2?'<button class="text-button" data-details="'+p.id+'">All '+contacts.length+' '+(group==='owner'?'ownership':group)+' contacts ↗</button>':'');
}
function contactDetails(p){
 const contacts=propertyContacts(p);
 const groups=['owner','management','leasing'];
 const featured=groups.flatMap(group=>contacts.filter(c=>contactGroup(c.role)===group).slice(0,2));
 const remaining=contacts.filter(c=>!featured.includes(c));
 return '<section class="property-contacts" aria-label="Property contacts"><h3>Property contacts</h3>'+(contacts.length?'<div class="contact-grid">'+featured.map(contactMarkup).join('')+'</div>'+(remaining.length?'<details class="more-contacts"><summary>More property contacts ('+remaining.length+')</summary><div class="contact-grid">'+remaining.map(contactMarkup).join('')+'</div></details>':''):'<p class="muted">Owner, management and leasing contacts are not reported for this property.</p>')+'<p class="contact-note">Recorded in the November 12, 2026 snapshot. Roles and contact details may have changed.</p></section>';
}
