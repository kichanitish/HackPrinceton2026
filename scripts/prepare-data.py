"""Create a minimal, contact-free apartment catalog from the provided CoStar kit."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
KIT=ROOT.parent/'costar-hackathon-kit'
def read(name):return [json.loads(x) for x in (KIT/'data'/f'{name}.jsonl').open()]
props={x['id']:x for x in read('commercial-property')}
enums=json.loads((KIT/'schemas/enums.json').read_text())
def label(group,value):return enums.get(group,{}).get(str(value),'Unknown')
def scans(attachments,scope):
 return [{'id':x['videoKey'],'scope':scope} for x in attachments or [] if x.get('videoExternalReferenceType') in [36,234] and x.get('videoKey')]
catalog=[]
for listing in read('apartment-listing'):
 p=props[listing['propertyId']];ap=p.get('propertyApartment') or {};profile=ap.get('residentialProfile') or {};address=p['primaryAddress']
 models={m['id']:m for m in ap.get('models') or []};plans=[]
 for m in listing.get('apartmentModels') or []:
  if (m.get('minRent') or 0)<=0 or (m.get('numUnitsAvailable') or 0)<=0 or m.get('rentPricingType')!=1:continue
  pm=models.get(m['id'],{});tours=scans(pm.get('attachments'),'Floor plan')
  for unit in pm.get('units') or []:tours+=scans(unit.get('attachments'),'Representative unit')
  tours=list({t['id']:t for t in tours}.values())
  if not tours:continue
  plans.append({'id':m['id'],'name':m.get('name') or pm.get('modelName') or 'Floor plan','beds':m.get('numBeds'),'baths':m.get('numBaths'),'sqftMin':m.get('minSquareFeet'),'sqftMax':m.get('maxSquareFeet'),'rentMin':m['minRent'],'rentMax':m.get('maxRent'),'currency':m.get('monetaryUnit'),'available':m['numUnitsAvailable'],'tours':tours})
 if not plans:continue
 plans.sort(key=lambda x:(x['beds'] if x['beds'] is not None else 99,x['rentMin']))
 photo=(listing.get('primaryPhoto') or {}).get('attachmentUri') or (p.get('primaryPhoto') or {}).get('attachmentUri')
 policies=[]
 for x in profile.get('petPolicies') or []:
  policies.append({k:v for k,v in {'type':label('PetType',x.get('petType')),'rent':x.get('rent'),'minFee':x.get('minFee'),'maxFee':x.get('maxFee'),'limit':x.get('numPets'),'weight':x.get('weight'),'restrictions':x.get('restrictions'),'currency':x.get('monetaryUnit')}.items() if v is not None})
 parking=[]
 for x in profile.get('parkingPolicies') or []:
  parking.append({k:v for k,v in {'type':label('ResidentialParkingType',x.get('parkingType')),'minFee':x.get('minSpaceFee'),'maxFee':x.get('maxSpaceFee'),'notes':x.get('comments')}.items() if v is not None})
 street=' '.join(str(address.get(k,'')) for k in ['streetNumber','streetDirection','streetName','streetType'] if address.get(k))
 catalog.append({'id':p['id'],'name':p.get('buildingName') or listing.get('buildingName') or street,'address':street,'city':'Houston' if address.get('researchMarketId')==14 else 'Los Angeles','state':address.get('state'),'zip':(address.get('postcode') or '')[:5],'lat':address.get('latitude'),'lng':address.get('longitude'),'photo':photo,'style':label('ApartmentStyleType',ap.get('apartmentStyleType')),'stories':p.get('numStoriesAboveGrade'),'units':listing.get('totalNumUnits'),'plans':plans,'pets':policies,'noPets':profile.get('hasNoPetsAllowed'),'parking':parking,'noParking':profile.get('hasNoParkingAvailable'),'manager':listing.get('propertyManagementCompanyName')})
catalog.sort(key=lambda x:x['name'].lower())
out={'snapshotDate':'2026-11-12','properties':catalog,'stats':{'properties':len(catalog),'plans':sum(len(x['plans']) for x in catalog),'cities':sorted({x['city'] for x in catalog})}}
(ROOT/'data/catalog.json').write_text(json.dumps(out,separators=(',',':')))
print(json.dumps(out['stats']))
