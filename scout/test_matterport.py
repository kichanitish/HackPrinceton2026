"""Quick check of what the Matterport Model API returns for one scan.

Usage (from the repo root, with .env filled in):
    pip install requests python-dotenv
    python test_matterport.py oNAvrNiXZS7

Model ids come from commercial-properties.csv (MatterportModelId column).
"""
import json
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()
URL = "https://api.matterport.com/api/models/graph"
AUTH = (os.environ["MATTERPORT_API_KEY"], os.environ["MATTERPORT_API_TOKEN"])

QUERIES = {
    "basic": """query($id: ID!) { model(id: $id) {
        id name created
        floors { id label }
        rooms { id label tags }
    }}""",
    # Room classification + dimensions need the Property Insights extension; errors here tell us what we have.
    "dimensions": """query($id: ID!) { model(id: $id) {
        dimensions { area areaIndoor units }
        floors { id label dimensions { area areaIndoor units } }
        rooms { id label classifications { label confidence }
                dimensions { width depth height area units } }
    }}""",
    "floorplans": """query($id: ID!) { model(id: $id) {
        assets { floorplans { format flags url } }
    }}""",
}


def run(name: str, model_id: str) -> None:
    r = requests.post(URL, auth=AUTH, json={"query": QUERIES[name], "variables": {"id": model_id}}, timeout=30)
    print(f"\n=== {name}: HTTP {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        print(r.text[:1000])
        return
    for err in body.get("errors", []):
        print("ERROR:", err.get("message"))
    if body.get("data"):
        print(json.dumps(body["data"], indent=2)[:4000])


if __name__ == "__main__":
    model_id = sys.argv[1] if len(sys.argv) > 1 else "oNAvrNiXZS7"
    for q in QUERIES:
        run(q, model_id)
