"""Download a one-time OpenStreetMap snapshot of places for Houston and Los Angeles (Overpass API).

Two kinds of place:
  anchors      things people search around: schools, universities, airports, hospitals, parks, transit,
               grocery stores, malls, hotels, neighbourhoods
  businesses   shops and services, used to count competitors and nearby draws for a commercial space

Small queries per group, several public mirrors, retries with back-off; finished groups are kept in
data/places/_parts so a rerun only fetches what's missing. Writes data/places/{houston,los_angeles}.json.
Only bounding boxes and tag names are sent. Run: python pipeline/fetch_places.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "places"
PARTS = OUT / "_parts"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
             "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
BBOX = {"houston": (29.45, -95.90, 30.15, -94.95), "los_angeles": (33.65, -118.75, 34.35, -117.85)}

GROUPS: dict[str, tuple[str, list[str]]] = {
    "education": ("anchors", ['nwr["amenity"~"^(school|college|university|kindergarten|library)$"]["name"]']),
    "health": ("anchors", ['nwr["amenity"="hospital"]["name"]']),
    "airports": ("anchors", ['nwr["aeroway"="aerodrome"]["iata"]']),
    "parks": ("anchors", ['nwr["leisure"="park"]["name"]']),
    "transit": ("anchors", ['nwr["railway"~"^(station|halt)$"]["name"]', 'nwr["public_transport"="station"]["name"]']),
    "shopping": ("anchors", ['nwr["shop"~"^(supermarket|mall|department_store)$"]["name"]']),
    "hotels": ("anchors", ['nwr["tourism"="hotel"]["name"]']),
    "areas": ("anchors", ['node["place"~"^(suburb|neighbourhood|quarter|town|city)$"]["name"]']),
    "food": ("businesses", ['nwr["amenity"~"^(cafe|restaurant|fast_food|bar|pub|ice_cream)$"]["name"]']),
    "services": ("businesses", ['nwr["amenity"~"^(pharmacy|clinic|doctors|dentist|childcare|bank|veterinary)$"]["name"]']),
    "shops": ("businesses", ['nwr["shop"~"^(bakery|pastry|confectionery|hairdresser|beauty|nails|massage|cosmetics|convenience|deli|butcher|alcohol|clothes|books|florist|pet|laundry|dry_cleaning|shoes|jewelry|gift|toys|furniture|coffee|tea)$"]["name"]']),
    "fitness": ("businesses", ['nwr["leisure"~"^(fitness_centre|sports_centre)$"]["name"]']),
    "offices": ("businesses", ['nwr["office"]["name"]']),
}
KEEP_TAGS = ("amenity", "shop", "leisure", "aeroway", "railway", "public_transport", "tourism", "place", "office",
             "cuisine", "iata", "operator")


def overpass(query: str) -> list[dict]:
    last = None
    for attempt in range(10):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": query}, timeout=200, headers={"User-Agent": "places-snapshot/1.0"})
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
                return r.json()["elements"]
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = type(e).__name__
        print(f"    {url.split('/')[2]}: {last}; retrying", file=sys.stderr, flush=True)
        time.sleep(min(60, 5 * (attempt + 1)))
    raise RuntimeError(f"Overpass failed: {last}")


def compact(el: dict, kind: str) -> dict | None:
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lon = el.get("lon") or (el.get("center") or {}).get("lon")
    tags = el.get("tags") or {}
    if lat is None or not tags.get("name"):
        return None
    row = {"id": f"{el['type'][0]}{el['id']}", "name": tags["name"], "lat": round(lat, 6), "lon": round(lon, 6), "kind": kind}
    row.update({k: tags[k] for k in KEEP_TAGS if k in tags})
    return row


def main() -> None:
    PARTS.mkdir(parents=True, exist_ok=True)
    failed = []
    for city, (s, w, n, e) in BBOX.items():
        bbox = f"{s},{w},{n},{e}"
        rows: dict[str, dict] = {}
        for group, (kind, selectors) in GROUPS.items():
            part = PARTS / f"{city}_{group}.json"
            if not part.exists():
                q = "[out:json][timeout:180];(" + "".join(f"{sel}({bbox});" for sel in selectors) + ");out center tags;"
                t = time.time()
                try:
                    els = overpass(q)
                except RuntimeError as err:
                    print(f"  {city} {group}: {err}", file=sys.stderr, flush=True)
                    failed.append(f"{city}/{group}")
                    continue
                part.write_text(json.dumps([r for r in (compact(el, kind) for el in els) if r]), encoding="utf-8")
                print(f"  {city} {group}: {len(els):,} in {time.time() - t:.0f}s", flush=True)
            for r in json.loads(part.read_text(encoding="utf-8")):
                rows[r["id"]] = r
        (OUT / f"{city}.json").write_text(json.dumps({"city": city, "bbox": [s, w, n, e], "source": "OpenStreetMap contributors (ODbL)",
                                                      "fetched": time.strftime("%Y-%m-%d"), "places": list(rows.values())}), encoding="utf-8")
        print(f"{city}: {len(rows):,} places saved", flush=True)
    if failed:
        print("still missing (rerun to retry): " + ", ".join(failed), flush=True)
        sys.exit(2)


if __name__ == "__main__":
    main()
