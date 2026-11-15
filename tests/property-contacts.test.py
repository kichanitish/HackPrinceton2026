import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('contacts', Path(__file__).resolve().parents[1] / 'scripts/property_contacts.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ContactAssociations(unittest.TestCase):
    def test_roles_portfolios_visibility_and_company_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            kit = Path(directory)
            (kit / 'data').mkdir()
            fixtures = {
                'company-detail': [{'id': 30, 'name': 'Management company', 'locationPhone': '5550100', 'locationPhoneCountryCode': 1}],
                'commercial-property': [{'id': 1, 'contacts': []}, {'id': 2, 'contacts': [{'contactRole': 4, 'locationId': 30}]}],
                'apartment-listing': [{'propertyId': 3, 'propertyManagementCompanyName': 'Management company', 'propertyManagementCompanyHqLocationId': 30}],
                'commercial-listing-summary': [{'propertyId': 1, 'forLeaseSummary': {'spaces': [{'propertyId': 1}, {'propertyId': 2}]},
                    'propertyContacts': [{'contactRole': 7, 'locationName': 'Owner of first property'}],
                    'listingContacts': [{'contactRole': 11, 'firstName': 'Broker', 'phoneNumber': '5550200', 'emailAddress': 'broker@example.com'},
                                        {'contactRole': 11, 'firstName': 'Hidden', 'displayInProduct': False}]}]
            }
            for name, rows in fixtures.items():
                (kit / 'data' / (name + '.jsonl')).write_text('\n'.join(map(json.dumps, rows)))
            index = module.contact_index(kit)
            self.assertTrue(any(c['role'] == 'Owner' for c in index[1]))
            self.assertFalse(any(c['role'] == 'Owner' for c in index[2]))
            self.assertTrue(any(c['role'] == 'Listing broker' for c in index[2]))
            self.assertFalse(any(c['name'] == 'Hidden' for contacts in index.values() for c in contacts))
            self.assertEqual(index[3][0]['phoneKind'], 'Company')
            self.assertEqual(index[3][0]['phone'], '5550100')
            catalog = {'properties': [{'id': -2, 'sourceId': 2}, {'id': 999}]}
            module.enrich(catalog, index)
            self.assertTrue(catalog['properties'][0]['contacts'])
            self.assertEqual(catalog['properties'][1]['contacts'], [])

if __name__ == '__main__':
    unittest.main()
