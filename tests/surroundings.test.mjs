import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {streetViewLinks} from '../src/surroundings.mjs';
const property={id:1,name:'Sample apartments',address:'2125 Yale St',city:'Houston',state:'TX',zip:'77008',lat:29.8058,lng:-95.3995};
test('Street View uses outdoor panoramas near the property and a key-free external fallback',()=>{
 const links=streetViewLinks(property,'browser-key'),embed=new URL(links.embed),external=new URL(links.external);
 assert.equal(embed.origin,'https://www.google.com');assert.equal(embed.pathname,'/maps/embed/v1/streetview');
 assert.equal(embed.searchParams.get('location'),'29.8058,-95.3995');assert.equal(embed.searchParams.get('source'),'outdoor');
 assert.equal(embed.searchParams.get('radius'),'100');assert.equal(embed.searchParams.get('key'),'browser-key');
 assert.equal(external.searchParams.get('map_action'),'pano');assert.equal(external.searchParams.get('viewpoint'),'29.8058,-95.3995');assert.equal(external.searchParams.has('key'),false);
 assert.equal(streetViewLinks(property,'').embed,null);
 for(const lat of [null,undefined,NaN,Infinity,91,'29.8'])assert.equal(streetViewLinks({...property,lat},'key'),null);
 assert.equal(streetViewLinks({...property,lng:-181},'key'),null);
});
const source=await readFile(new URL('../src/live.js',import.meta.url),'utf8');
function mount(key){
 const make=()=>({children:[],dataset:{},hidden:false,attributes:{},append(...nodes){this.children.push(...nodes)},setAttribute(k,v){this.attributes[k]=v},focus(){this.focused=true},querySelectorAll(){return []}});
 const street=make(),aerial=make(),tabs=['street','aerial'].map(mode=>({...make(),dataset:{exterior:mode}}));
 const root={...make(),isConnected:true,querySelector:s=>s.includes('="street"')?street:aerial,querySelectorAll:()=>tabs};
 let coverageCalls=0;
 const context=vm.createContext({config:{googleMapsEmbedKey:key},streetViewLinks,property,root,escape:String,document:{createElement:make},loadCoverage:async()=>{coverageCalls++;return {ok:false,state:'unavailable'}},aerialMarkup:()=>'<p>Aerial fallback</p>',bindAerialImages(){}});
 vm.runInContext(source.slice(source.indexOf('let surroundingsSequence=0;')),context);
 vm.runInContext('mountSurroundings(root,property,true)',context);
 return {street,aerial,tabs,calls:()=>coverageCalls};
}
test('configured Street View is primary, aerial loads only on request, and tabs preserve the iframe',async()=>{
 const ui=mount('browser-key');assert.equal(ui.street.hidden,false);assert.equal(ui.aerial.hidden,true);assert.equal(ui.calls(),0);
 const frame=ui.street.children[1];assert.match(frame.src,/\/embed\/v1\/streetview/);assert.equal(frame.referrerPolicy,'strict-origin-when-cross-origin');assert.equal(frame.allowFullscreen,true);
 ui.tabs[1].onclick();await Promise.resolve();assert.equal(ui.calls(),1);assert.equal(ui.street.hidden,true);assert.equal(ui.aerial.hidden,false);
 ui.tabs[0].onclick();assert.equal(ui.street.children[1],frame);ui.tabs[1].onclick();assert.equal(ui.calls(),1);
});
test('without a Google key aerial remains primary and Street View offers a public Maps link',async()=>{
 const ui=mount(null);await Promise.resolve();assert.equal(ui.calls(),1);assert.equal(ui.aerial.hidden,false);
 ui.tabs[0].onclick();assert.equal(ui.street.hidden,false);assert.equal(ui.street.children.length,1);assert.match(ui.street.children[0].href,/map_action=pano/);
 let prevented=false;ui.tabs[0].onkeydown({key:'ArrowRight',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(ui.tabs[1].focused,true);assert.equal(ui.aerial.hidden,false);
});

test('property locator uses the complete listing address and switches back to the nearby panorama',()=>{
 const links=streetViewLinks(property,'browser-key'),place=new URL(links.placeEmbed);
 assert.equal(place.pathname,'/maps/embed/v1/place');assert.equal(place.searchParams.get('q'),'2125 Yale St, Houston, TX, 77008');
 assert.equal(new URL(links.propertyMap).searchParams.get('query'),'2125 Yale St, Houston, TX, 77008');
 const ui=mount('browser-key'),bar=ui.street.children[0],frame=ui.street.children[1],button=bar.children[1];
 assert.equal(bar.children[0].children[1].textContent,'2125 Yale St, Houston, TX, 77008');
 button.onclick();assert.equal(frame.src,links.placeEmbed);assert.equal(button.attributes['aria-pressed'],'true');assert.match(frame.title,/property location/);
 button.onclick();assert.equal(frame.src,links.embed);assert.equal(button.attributes['aria-pressed'],'false');assert.match(frame.title,/Street View/);
});
