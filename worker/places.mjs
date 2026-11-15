// Small, user-triggered place lookups. Never geocode the whole catalog or accept model-invented coordinates.
const placeQueries=new Map(),placeChoices=new Map();let lastPlaceLookup=0;
const cityCenters={'Los Angeles':{lat:34.0522,lng:-118.2437},Houston:{lat:29.7604,lng:-95.3698}};
const laxPlace={id:'landmark:lax',name:'Los Angeles International Airport (LAX)',lat:33.9424963889,lng:-118.4080486111,city:'Los Angeles',source:'FAA airport reference point',sourceUrl:'https://www.faa.gov/air_traffic/publications/atpubs/aip_html/part3_ad_2.0_california.html'};
export function distanceMiles(a,b){
 if(![a?.lat,a?.lng,b?.lat,b?.lng].every(Number.isFinite)||Math.abs(a.lat)>90||Math.abs(b.lat)>90||Math.abs(a.lng)>180||Math.abs(b.lng)>180)return null;
 const rad=x=>x*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lng-a.lng),h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;
 return 3958.7613*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
export function supportedCityForPlace(place){return Object.entries(cityCenters).map(([city,center])=>({city,miles:distanceMiles(place,center)})).filter(x=>x.miles!==null&&x.miles<=120).sort((a,b)=>a.miles-b.miles)[0]?.city||null}
function rememberPlace(place){if(placeChoices.size>=120)placeChoices.delete(placeChoices.keys().next().value);placeChoices.set(place.id,{place,until:Date.now()+86400000});return place}
export async function resolveMatchPlace({query,city,choiceId=null},env={},fetcher=fetch){
 if(choiceId===laxPlace.id)return {status:'resolved',place:laxPlace};
 if(choiceId){const cached=placeChoices.get(choiceId);return cached&&cached.until>Date.now()?{status:'resolved',place:cached.place}:{status:'unavailable'}}
 if(typeof query!=='string'||!query.trim()||query.length>180)return {status:'unavailable'};
 if(/^(?:lax|los angeles (?:international )?airport)(?:\s*,?\s*(?:los angeles|california|ca|usa|us))*$/i.test(query.trim()))return {status:'resolved',place:laxPlace};
 const cacheKey=city+':'+query.trim().toLowerCase(),cached=placeQueries.get(cacheKey);if(cached&&cached.until>Date.now())return cached.result;
 if(Date.now()-lastPlaceLookup<1100)return {status:'unavailable'};lastPlaceLookup=Date.now();
 try{
  const url=new URL('/api/',env.HOMEFIT_GEOCODER_URL||'https://photon.komoot.io');
  url.search=new URLSearchParams({q:query.trim(),limit:'5',lang:'en',lat:String(cityCenters[city]?.lat||34.0522),lon:String(cityCenters[city]?.lng||-118.2437)}).toString();
  const response=await fetcher(url,{headers:{accept:'application/json','user-agent':'Scout/0.4 property-search'},signal:AbortSignal.timeout(7000)});if(!response.ok)return {status:'unavailable'};
  const data=await response.json(),places=[],houseNumber=query.trim().match(/^(\d+[A-Za-z]?)\s+\S/)?.[1]?.toLowerCase();
  for(const feature of (data.features||[]).slice(0,5)){
   const p=feature.properties||{},coordinates=feature.geometry?.coordinates;if(!Array.isArray(coordinates))continue;
   if(houseNumber&&String(p.housenumber||'').toLowerCase()!==houseNumber)continue;
   const place={id:'osm:'+p.osm_type+':'+p.osm_id,name:[p.name,[p.housenumber,p.street].filter(Boolean).join(' ')||p.postcode,p.city,p.state,p.countrycode&&String(p.countrycode).toUpperCase()!=='US'?p.country:null].filter(Boolean).join(', ').slice(0,180),lat:coordinates[1],lng:coordinates[0],source:'© OpenStreetMap contributors',sourceUrl:'https://www.openstreetmap.org/copyright'};
   if(!place.name||distanceMiles(place,place)===null||places.some(x=>x.name===place.name&&distanceMiles(x,place)<.5))continue;
   place.city=supportedCityForPlace(place);places.push(rememberPlace(place));
  }
  const nearby=places.filter(p=>p.city===city),options=nearby.length?nearby:places;
  const result=options.length===1?{status:'resolved',place:options[0]}:options.length?{status:'ambiguous',choices:options.slice(0,3)}:{status:'unavailable'};
  if(placeQueries.size>=100)placeQueries.delete(placeQueries.keys().next().value);placeQueries.set(cacheKey,{result,until:Date.now()+3600000});return result;
 }catch{return {status:'unavailable'}}
}
