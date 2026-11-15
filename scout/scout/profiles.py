"""Commercial business profiles: who a business's customers are, who competes with it, what kind of space and fit-out
help, and what nearby places send it customers. Market knowledge, not legal rules; sizes and rents come from data.
"""
from __future__ import annotations

import re
from typing import Any

# osm: tags that mark a competitor. draws: anchor categories (or 'office') that bring customers.
# customers: weights for residents / office workers / students / visitors when scoring areas.
PROFILES: dict[str, dict[str, Any]] = {
    "cafe": {"label": "Coffee shop", "words": r"caf[eé]|coffee|espresso|tea ?(house|shop|room)|boba",
             "osm": {"amenity": ["cafe"], "shop": ["coffee", "tea"]}, "tenant": "cafe",
             "uses": ["Retail", "OfficeRetail"], "fitout": r"kitchen|hood|grease|caf[eé]|coffee|restaurant|food|second[- ]generation|plumb",
             "customers": {"workers": 1.0, "residents": 0.7, "students": 0.8, "visitors": 0.5},
             "draws": ["office", "university", "transit", "hotel", "gym"], "size": (800, 2000)},
    "bakery": {"label": "Bakery", "words": r"bak(ery|eries|er)|pastr|patisserie|donut|doughnut|cupcake|dessert",
               "osm": {"shop": ["bakery", "pastry", "confectionery"]}, "tenant": "cafe",
               "uses": ["Retail", "OfficeRetail", "Flex"], "fitout": r"kitchen|hood|grease|oven|bak|restaurant|food|second[- ]generation|plumb",
               "customers": {"residents": 1.0, "workers": 0.8, "students": 0.5, "visitors": 0.5},
               "draws": ["office", "school", "grocery", "transit"], "size": (900, 2200)},
    "restaurant": {"label": "Restaurant", "words": r"restaurant|diner|bistro|eatery|taqueria|pizz|burger|sushi|ramen|grill|kitchen|food",
                   "osm": {"amenity": ["restaurant", "fast_food"]}, "tenant": "restaurant",
                   "uses": ["Retail", "OfficeRetail"], "fitout": r"kitchen|hood|grease|restaurant|food|second[- ]generation|walk-?in|plumb",
                   "customers": {"residents": 0.9, "workers": 0.9, "visitors": 0.8, "students": 0.5},
                   "draws": ["office", "hotel", "transit", "university", "mall"], "size": (1500, 3500)},
    "bar": {"label": "Bar", "words": r"\bbar\b|pub|brewery|taproom|lounge|wine bar|cocktail",
            "osm": {"amenity": ["bar", "pub"]}, "tenant": "restaurant",
            "uses": ["Retail", "OfficeRetail"], "fitout": r"bar|restaurant|kitchen|liquor|second[- ]generation",
            "customers": {"residents": 0.8, "visitors": 0.9, "workers": 0.7, "students": 0.6},
            "draws": ["hotel", "transit", "university", "office"], "size": (1500, 4000)},
    "gym": {"label": "Gym", "words": r"gym|fitness|yoga|pilates|crossfit|boxing|martial|dance studio|cycling studio",
            "osm": {"leisure": ["fitness_centre", "sports_centre"]}, "tenant": "gym",
            "uses": ["Retail", "Flex", "OfficeRetail", "Industrial"], "fitout": r"gym|fitness|shower|locker|high ceiling|open",
            "customers": {"residents": 1.0, "workers": 0.7, "students": 0.4, "visitors": 0.1},
            "draws": ["office", "grocery", "park"], "size": (2000, 6000)},
    "salon": {"label": "Salon", "words": r"salon|barber|hair|nail|spa\b|beauty|lash|brow|wax|massage|esthetic",
              "osm": {"shop": ["hairdresser", "beauty", "nails", "massage", "cosmetics"]}, "tenant": None,
              "uses": ["Retail", "OfficeRetail"], "fitout": r"salon|plumb|sink|shampoo|beauty|spa",
              "customers": {"residents": 1.0, "workers": 0.6, "visitors": 0.2, "students": 0.3},
              "draws": ["grocery", "mall", "office"], "size": (700, 1800)},
    "clinic": {"label": "Clinic", "words": r"clinic|medical|doctor|dental|dentist|orthodont|physio|physical therapy|chiropract|urgent care|pediatric|dermatolog|optometr|therapy|med ?spa",
               "osm": {"amenity": ["clinic", "doctors", "dentist"]}, "tenant": "clinic",
               "uses": ["OfficeMedical", "Medical", "Office", "OfficeRetail"], "fitout": r"exam|medical|dental|clinic|plumb|x-?ray|lab|sink",
               "customers": {"residents": 1.0, "workers": 0.4, "visitors": 0.1, "students": 0.2},
               "draws": ["hospital", "grocery", "office"], "size": (1200, 3000)},
    "pharmacy": {"label": "Pharmacy", "words": r"pharmac|drugstore|apothecary",
                 "osm": {"amenity": ["pharmacy"]}, "tenant": None,
                 "uses": ["Retail", "OfficeRetail", "OfficeMedical", "Medical"], "fitout": r"pharmac|medical|retail",
                 "customers": {"residents": 1.0, "workers": 0.5, "visitors": 0.2, "students": 0.2},
                 "draws": ["hospital", "grocery"], "size": (1000, 3000)},
    "daycare": {"label": "Daycare", "words": r"daycare|day care|child ?care|preschool|pre-k|nursery|montessori|kids|learning cent",
                "osm": {"amenity": ["childcare", "kindergarten"]}, "tenant": "daycare",
                "uses": ["Retail", "Office", "OfficeRetail", "Flex"], "fitout": r"daycare|child|school|play|restroom|ground",
                "customers": {"residents": 1.0, "workers": 0.6, "students": 0.0, "visitors": 0.0},
                "draws": ["school", "park", "office"], "size": (2500, 6000)},
    "retail": {"label": "Retail store", "words": r"boutique|cloth|apparel|fashion|store|shop|gift|book|florist|flower|jewel|shoe|vintage|thrift|record|toy|furniture|decor",
               "osm": {"shop": ["clothes", "gift", "books", "florist", "shoes", "jewelry", "toys", "furniture"]}, "tenant": None,
               "uses": ["Retail", "OfficeRetail"], "fitout": r"retail|storefront|display|frontage|window",
               "customers": {"visitors": 0.9, "residents": 0.8, "workers": 0.6, "students": 0.4},
               "draws": ["mall", "transit", "hotel", "grocery"], "size": (800, 2500)},
    "grocery": {"label": "Grocery / convenience", "words": r"grocer|convenience|market|deli|bodega|liquor|butcher",
                "osm": {"shop": ["convenience", "supermarket", "deli", "butcher", "alcohol"]}, "tenant": None,
                "uses": ["Retail", "OfficeRetail"], "fitout": r"cooler|refrigerat|grocery|retail|food",
                "customers": {"residents": 1.0, "workers": 0.5, "visitors": 0.3, "students": 0.3},
                "draws": ["transit", "office"], "size": (1500, 5000)},
    "pet": {"label": "Pet business", "words": r"\bpet|groom|veterinar|\bvet\b|dog|cat\b",
            "osm": {"shop": ["pet"], "amenity": ["veterinary"]}, "tenant": None,
            "uses": ["Retail", "OfficeRetail", "Flex"], "fitout": r"plumb|kennel|vet|pet|retail",
            "customers": {"residents": 1.0, "workers": 0.3, "visitors": 0.1, "students": 0.1},
            "draws": ["park", "grocery"], "size": (1200, 3000)},
    "laundry": {"label": "Laundromat / cleaners", "words": r"laund|dry ?clean|wash",
                "osm": {"shop": ["laundry", "dry_cleaning"]}, "tenant": None,
                "uses": ["Retail", "OfficeRetail"], "fitout": r"plumb|laund|vent|drain",
                "customers": {"residents": 1.0, "workers": 0.4, "visitors": 0.0, "students": 0.3},
                "draws": ["grocery"], "size": (1000, 3000)},
    "office": {"label": "Office", "words": r"office|agency|studio|startup|firm|consult|law|account|architect|design|real estate|insurance|tech",
               "osm": {"office": []}, "tenant": None,
               "uses": ["Office", "OfficeRetail", "Flex"], "fitout": r"office|conference|private|reception|furnished|built-?out",
               "customers": {"workers": 0.6, "residents": 0.3, "visitors": 0.2, "students": 0.2},
               "draws": ["transit", "office", "hotel"], "size": (800, 4000)},
}
DEFAULT = "retail"


def match_profile(text: str | None) -> str:
    t = (text or "").lower()
    for key, p in PROFILES.items():
        if re.search(p["words"], t):
            return key
    return DEFAULT


def competitor_pred(key: str):
    osm = PROFILES[key]["osm"]

    def pred(r: dict) -> bool:
        for tag, values in osm.items():
            v = r.get(tag)
            if v is not None and (not values or v in values):
                return True
        return False
    return pred
