"""Extract explicitly recorded property contacts, keeping ownership and leasing roles separate."""
import json
from collections import defaultdict
from pathlib import Path

ROLES = {3: 'Recorded owner', 7: 'Owner', 4: 'Property manager', 6: 'Leasing company',
         20: 'Leasing company', 11: 'Listing broker', 46: 'Listing agent',
         47: 'Leasing agent', 52: 'Owner listing contact'}

def contact_index(kit):
    def rows(name):
        return [json.loads(line) for line in (kit / 'data' / (name + '.jsonl')).open() if line.strip()]
    companies = {r['id']: r for r in rows('company-detail')}
    contacts = defaultdict(list)

    def add(pid, raw, company_only=False):
        role = ROLES.get(raw.get('contactRole'))
        if not role or raw.get('displayInProduct') is False:
            return
        company = companies.get(raw.get('locationId')) or {}
        name = ' '.join(str(raw.get(k) or '').strip() for k in ('firstName', 'lastName')).strip()
        organization = raw.get('locationName') or company.get('name')
        if not name and not organization:
            return
        direct_phone = raw.get('phoneNumber')
        phone = direct_phone or company.get('locationPhone')
        item = {'role': role, 'name': name or None, 'company': organization or None,
                'email': raw.get('emailAddress') or None, 'phone': str(phone) if phone else None,
                'countryCode': raw.get('phoneNumberCountryCode') if direct_phone else company.get('locationPhoneCountryCode'),
                'extension': str(raw['phoneExt']) if raw.get('phoneExt') else None,
                'phoneKind': 'Contact' if direct_phone and not company_only else 'Company',
                'source': 'CoStar snapshot'}
        contacts[pid].append(item)

    for listing in rows('commercial-listing-summary'):
        # Brokers represent advertised spaces; ownership/management links remain property-specific.
        pid = listing.get('propertyId')
        advertised = {s['propertyId'] for s in (listing.get('forLeaseSummary') or {}).get('spaces', []) if s.get('propertyId')}
        if pid:
            advertised.add(pid)
        for raw in listing.get('listingContacts') or []:
            targets = advertised if raw.get('contactRole') in (11, 46, 47) else ({pid} if pid else set())
            for target in targets:
                add(target, raw)
        if pid:
            for raw in listing.get('propertyContacts') or []:
                add(pid, raw)
    for prop in rows('commercial-property'):
        for raw in prop.get('contacts') or []:
            add(prop['id'], raw, company_only=True)
    for listing in rows('apartment-listing'):
        pid = listing['propertyId']
        manager = listing.get('propertyManagementCompanyName')
        if manager:
            company = companies.get(listing.get('propertyManagementCompanyHqLocationId')) or {}
            add(pid, {'contactRole': 4, 'locationName': manager,
                      'phoneNumber': company.get('locationPhone'),
                      'phoneNumberCountryCode': company.get('locationPhoneCountryCode')}, company_only=True)

    result = {}
    for pid, items in contacts.items():
        unique = {}
        for item in items:
            key = (item['role'], (item['name'] or '').casefold(), (item['company'] or '').casefold())
            if key not in unique:
                unique[key] = item
            else:
                for field in ('email', 'phone', 'countryCode', 'extension'):
                    if not unique[key].get(field) and item.get(field):
                        unique[key][field] = item[field]
        result[pid] = sorted(unique.values(), key=lambda c: (list(ROLES.values()).index(c['role']), c['company'] or '', c['name'] or ''))
    return result

def enrich(catalog, index):
    for prop in catalog['properties']:
        prop['contacts'] = index.get(prop.get('sourceId') or prop['id'], [])
    return catalog

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    index = contact_index(root.parent / 'costar-hackathon-kit')
    for name in ('catalog.json', 'commercial-catalog.json'):
        path = root / 'data' / name
        catalog = enrich(json.loads(path.read_text()), index)
        path.write_text(json.dumps(catalog, separators=(',', ':')))
        print(name, sum(bool(p['contacts']) for p in catalog['properties']), 'properties with contacts')
