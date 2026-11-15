"""Adapt Scout's commercial suite/tour/rate helpers and recorded property contacts."""
import ast,json,re,math,statistics
from property_contacts import contact_index, enrich
from pathlib import Path
from collections import defaultdict
ROOT=Path(__file__).resolve().parents[1];KIT=ROOT.parent/'costar-hackathon-kit'
E=json.loads((KIT/'schemas/enums.json').read_text())
def read(name):return [json.loads(line) for line in (KIT/'data'/name).open() if line.strip()]
def decode(group,value):return E.get(group,{}).get(str(value),'Unknown')
def address(a):return ' '.join(str(a[k]) for k in ['streetNumber','streetPreDirection','streetName','streetType','streetPostDirection'] if a.get(k))
# Retain teammate's tested tour association, caption matching, floor labels and feature extraction.
source=ast.parse((ROOT/'scout/pipeline/build_spaces.py').read_text())
functions={'floor_number','floor_label','yearly','norm_suite','collect_tours','pick_tour','year_built'}
constants={'MATTERPORT_REF_TYPES','GROUND_FLOORS','ORDINALS','TENS','UNITS','NOTE_FEATURES','SUITE_IN_CAPTION','SQFT_IN_CAPTION','APARTMENT_UNIT_CAPTION'}
nodes=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)]
for node in source.body:
 name=node.name if isinstance(node,ast.FunctionDef) else node.target.id if isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name) else node.targets[0].id if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) else None
 if name in functions|constants:nodes.append(node)
helpers={'re':re,'decode':decode,'split_camel':lambda value:re.sub(r'(?<=[a-z])(?=[A-Z])',' ',value)};exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'scout-commercial-helpers','exec'),helpers)
profile_tree=ast.parse((ROOT/'scout/scout/profiles.py').read_text())
profiles=ast.literal_eval(next(n.value for n in profile_tree.body if isinstance(n,ast.AnnAssign) and getattr(n.target,'id',None)=='PROFILES'))
(ROOT/'data/business-profiles.json').write_text(json.dumps(profiles,separators=(',',':')))
props={p['id']:p for p in read('commercial-property.jsonl')};groups={}
for listing in read('commercial-listing-summary.jsonl'):
 if listing.get('listingStatus')!=1:continue
 lease=listing.get('forLeaseSummary')or{};extra={p['id']:p for p in lease.get('properties')or[] if p.get('id')}
 for space in lease.get('spaces')or[]:
  pid=space['propertyId'];p=props.get(pid)or{};fallback=extra.get(pid)or{};a=p.get('primaryAddress')or fallback.get('address')or(space.get('marketingAddress')or{})or(listing.get('address')if pid==listing.get('propertyId')else{})or{}
  market=a.get('researchMarketId')or(14 if a.get('state')=='TX' else 20 if a.get('state')=='CA' else None)
  if market not in (14,20) or not isinstance(a.get('latitude'),(int,float)) or not isinstance(a.get('longitude'),(int,float)):continue
  if space.get('isLeasePending'):continue
  low=space.get('squareFeetMin')or space.get('squareFeetMax');high=space.get('squareFeetMax')or low
  if not low or not high:continue
  basis=space.get('rateBasis');rateLow=helpers['yearly'](space.get('rateLow'),basis)if basis in(1,2)else None;rateHigh=helpers['yearly'](space.get('rateHigh'),basis)if basis in(1,2)else None
  rateHigh=rateHigh or rateLow
  notes=' '.join(n['value'].strip() for n in space.get('notes')or[] if n.get('value'))
  attachments=(p.get('attachments')or[])+((listing.get('attachments')or[])if pid==listing.get('propertyId')else[])
  tours=helpers['collect_tours'](attachments);tour=helpers['pick_tour'](space,tours)
  photo=(p.get('primaryPhoto')or fallback.get('primaryPhoto')or{}).get('attachmentUri')
  if not photo:photo=next((x.get('attachmentUri')for x in attachments if re.search(r'\.(jpg|jpeg|png)(?:\?|$)',x.get('attachmentUri')or'',re.I)),None)
  parking=sum(x.get('totalSpaces')or 0 for x in p.get('parking')or[])or None;floor=decode('FloorName',space.get('floorName'))
  g=groups.setdefault(pid,{'id':-pid,'sourceId':pid,'mode':'commercial','name':p.get('buildingName')or(listing.get('buildingName')if pid==listing.get('propertyId')else None)or address(a),'address':address(a),'city':'Houston'if market==14 else'Los Angeles','state':a.get('state'),'zip':(a.get('postcode')or'')[:5],'lat':a['latitude'],'lng':a['longitude'],'photo':photo,'style':decode('PropertyType',p.get('propertyType')or listing.get('propertyType')),'stories':p.get('numStoriesAboveGrade'),'pets':[],'parking':[{'type':'Parking','spaces':parking}]if parking or p.get('parkingRatio')else[],'parkingSpaces':parking,'parkingRatio':p.get('parkingRatio'),'plans':[],'manager':listing.get('brokerageCompanyName'),'zoning':p.get('zoningDescription')})
  sid=space['id']
  if any(x['id']==sid for x in g['plans']):continue
  selectedTours=[]
  if tour:selectedTours=[{'id':tour['model_id'],'scope':'Suite'if tour['level']=='suite'else'Building'if tour['level']=='building'else'Unverified space','matchedBy':tour.get('matched_by')}]
  g['plans'].append({'id':sid,'name':('Suite '+str(space['suite']))if space.get('suite')else helpers['floor_label'](floor,helpers['floor_number'](floor)),'suite':space.get('suite'),'beds':None,'baths':None,'sqftMin':low,'sqftMax':high,'rentMin':round(rateLow*low/12,2)if rateLow else None,'rentMax':round(rateHigh*high/12,2)if rateHigh else None,'annualRateMin':rateLow,'annualRateMax':rateHigh,'rateBasis':decode('RateBasis',basis),'serviceType':decode('ServiceType',space.get('serviceType')),'available':1,'availableDate':space.get('availableOnDate'),'use':decode('SpaceUse',space.get('spaceUse')),'isGround':floor in helpers['GROUND_FLOORS'],'floorLabel':helpers['floor_label'](floor,helpers['floor_number'](floor)),'notes':re.sub(r'\s+',' ',notes)[:900],'features':[key for key,pattern in helpers['NOTE_FEATURES'].items()if pattern.search(notes)],'floorplan':(space.get('floorPlan')or{}).get('attachmentUri'),'tours':selectedTours})
# Market context, not a promise of future demand or revenue. Store aggregates only.
companies={x['id']:x for x in read('company-detail.jsonl')};workers=defaultdict(int);tenantUses=defaultdict(set);deals=defaultdict(list)
for occ in read('location-occupancy.jsonl'):
 company=companies.get(occ.get('tenantLocationId'))or{};pid=occ.get('propertyId');name=company.get('name')or(company.get('profile')or{}).get('companyName')or''
 if not occ.get('toDate'):
  workers[pid]+=company.get('numEmployees')or 0
  for key,profile in profiles.items():
   if re.search(profile['words'],name,re.I):tenantUses[pid].add(key)
 deal=occ.get('leaseDeal')or{};a=(props.get(pid)or{}).get('primaryAddress')or{};basis=deal.get('rateBasis');signed=deal.get('signDate')or deal.get('commencementDate')or'';rate=deal.get('rateActual')
 if rate and rate>0 and basis in(1,2)and signed[:4].isdigit()and int(signed[:4])>=2018:
  deals[(a.get('researchMarketId'),decode('SpaceUse',deal.get('spaceUse')),decode('ServiceType',deal.get('serviceType')))].append(rate*12 if basis==1 else rate)
points=[]
apt={x['propertyId']:x.get('totalNumUnits')or 0 for x in read('apartment-listing.jsonl')}
for pid,p in props.items():
 a=p.get('primaryAddress')or{};lat,lng=a.get('latitude'),a.get('longitude')
 if isinstance(lat,(int,float))and isinstance(lng,(int,float)):points.append((pid,lat,lng,apt.get(pid)or(p.get('propertyApartment')or{}).get('totalNumUnits')or 0,workers[pid],p.get('propertyType')==5))
def miles(a,b,c,d):
 r=math.pi/180;h=math.sin((c-a)*r/2)**2+math.cos(a*r)*math.cos(c*r)*math.sin((d-b)*r/2)**2;return 7917.5226*math.asin(min(1,math.sqrt(h)))
for pid,g in groups.items():
 units=employees=offices=0
 for other,lat,lng,n,w,office in points:
  if abs(lat-g['lat'])<.009 and abs(lng-g['lng'])<.012 and miles(lat,lng,g['lat'],g['lng'])<=.5:units+=n;employees+=w;offices+=int(office)
 g['businessContext']={'nearbyApartmentUnits':units or None,'recordedWorkers':employees or None,'officeBuildings':offices or None,'radiusMiles':.5,'tenantCategories':sorted(tenantUses[pid])}
 for plan in g['plans']:
  values=deals.get((14 if g['city']=='Houston' else 20,plan['use'],plan['serviceType']),[])
  if len(values)>=5:plan['rentBenchmark']={'medianAnnualRate':round(statistics.median(values),2),'n':len(values),'sinceYear':2018,'serviceType':plan['serviceType']}
 g['plans'].sort(key=lambda x:x['rentMin']if x['rentMin']is not None else float('inf'))
properties=sorted(groups.values(),key=lambda x:x['name'].lower());out={'snapshotDate':'2026-11-12','properties':properties,'stats':{'properties':len(properties),'spaces':sum(len(x['plans'])for x in properties),'withPhotos':sum(bool(x['photo'])for x in properties),'spacesWithTours':sum(bool(x['tours'])for p in properties for x in p['plans'])}}
enrich(out, contact_index(KIT))
(ROOT/'data/commercial-catalog.json').write_text(json.dumps(out,separators=(',',':')))
print(json.dumps(out['stats']))
