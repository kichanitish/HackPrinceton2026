// Public listing coordinates only; server credentials never enter these URLs.
export function streetViewLinks(property,key){
 const {lat,lng}=property;
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return null;
 const location=lat+','+lng;
 const external=new URL('https://www.google.com/maps/@');
 external.search=new URLSearchParams({api:'1',map_action:'pano',viewpoint:location}).toString();
 const address=[property.address,property.city,property.state,property.zip].filter(Boolean).join(', ');
 const placeQuery=address||location;
 const propertyMap=new URL('https://www.google.com/maps/search/');
 propertyMap.search=new URLSearchParams({api:'1',query:placeQuery}).toString();
 let embed=null,placeEmbed=null;
 if(typeof key==='string'&&key.trim()){
  const url=new URL('https://www.google.com/maps/embed/v1/streetview');
  url.search=new URLSearchParams({key:key.trim(),location,radius:'100',source:'outdoor',fov:'90'}).toString();embed=url.href;
  const place=new URL('https://www.google.com/maps/embed/v1/place');
  place.search=new URLSearchParams({key:key.trim(),q:placeQuery,zoom:'18'}).toString();placeEmbed=place.href;
 }
 return {external:external.href,embed,placeEmbed,propertyMap:propertyMap.href,address};
}
