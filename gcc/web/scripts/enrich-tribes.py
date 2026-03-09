#!/usr/bin/env python3
"""Enrich empty/sparse tribe entries using Claude API."""

import json
import os
import time
import sys
from pathlib import Path

# Load API key
env_path = Path(__file__).resolve().parents[3] / "web" / ".env.local"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("ANTHROPIC_API_KEY="):
            os.environ["ANTHROPIC_API_KEY"] = line.split("=", 1)[1].strip()

API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not API_KEY:
    print("ERROR: No ANTHROPIC_API_KEY found")
    sys.exit(1)

import urllib.request
import urllib.error

DATA_DIR = Path(__file__).resolve().parents[1] / "src" / "data"
TRIBES_FILE = DATA_DIR / "tribes.json"

tribes = json.loads(TRIBES_FILE.read_text())

# Schema for enrichment
TRIBE_FIELDS = [
    "nameAr", "formationType", "legitimacyNotes", "ancestorName", "ancestorStory",
    "lineageRoot", "foundingEra", "status", "peakPowerEra", "traditionalEconomy",
    "alignment", "description"
]

VALID_FORMATION_TYPES = ["confederation", "single_tribe", "clan", "sub_tribe", "dynasty", "tribal_branch"]
VALID_LINEAGE_ROOTS = ["qahtani", "adnani", "mixed", "unknown"]
VALID_STATUS = ["active", "historical", "merged", "extinct", "dormant"]
VALID_ALIGNMENT = ["ghafiri", "hinawi", "neutral", "na"]


def needs_enrichment(tribe):
    """Check if a tribe needs enrichment."""
    empty_fields = sum(1 for f in TRIBE_FIELDS if not tribe.get(f))
    return empty_fields >= 6  # Missing more than half the fields


def call_claude(prompt, max_tokens=2000):
    """Call Claude API directly via urllib."""
    data = json.dumps({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=data,
        headers={
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result["content"][0]["text"]
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  API error {e.code}: {body[:200]}")
        if e.code == 429:
            time.sleep(10)
            return None
        return None
    except Exception as e:
        print(f"  Request error: {e}")
        return None


def build_prompt(tribe, all_tribe_names):
    """Build enrichment prompt for a tribe."""
    existing = {k: v for k, v in tribe.items() if v and k in TRIBE_FIELDS}
    existing_relations = tribe.get("relations", [])
    rel_context = ""
    if existing_relations:
        rel_context = "Known relations: " + ", ".join(
            f"{r['tribeId']} ({r['type']})" for r in existing_relations[:5]
        )

    return f"""You are a historian specializing in Arabian Peninsula tribal genealogy and Gulf (GCC) history.

Fill in missing data for this tribe. Return ONLY valid JSON (no markdown, no explanation).

Tribe: {tribe['name']} (id: {tribe['id']})
{f"Existing data: {json.dumps(existing)}" if existing else "No existing data."}
{rel_context}

Return a JSON object with these fields (use null if truly unknown, don't fabricate):
{{
  "nameAr": "Arabic name in Arabic script",
  "formationType": one of {json.dumps(VALID_FORMATION_TYPES)},
  "legitimacyNotes": "brief note on their legitimacy/authority basis",
  "ancestorName": "name of tribal ancestor or progenitor",
  "ancestorStory": "1-2 sentence origin/ancestor narrative",
  "lineageRoot": one of {json.dumps(VALID_LINEAGE_ROOTS)},
  "foundingEra": "approximate era (e.g. 'pre-Islamic', '7th century', '18th century')",
  "status": one of {json.dumps(VALID_STATUS)},
  "peakPowerEra": "era of greatest influence",
  "traditionalEconomy": "primary economic activity (e.g. 'nomadic pastoralism', 'pearling and trade', 'date farming')",
  "alignment": one of {json.dumps(VALID_ALIGNMENT)} (Ghafiri/Hinawi is specific to Oman tribal politics - use 'na' if not applicable),
  "description": "2-4 sentence factual description covering: who they are, where they're historically based, notable history, and current status. Focus on GCC relevance.",
  "newRelations": [
    {{"tribeId": "existing_tribe_id", "type": "alliance|rivalry|shared_lineage|shared_migration|patron_client|intermarriage", "context": "brief context", "strength": "strong|moderate|historical_only"}}
  ]
}}

IMPORTANT:
- For newRelations, ONLY use tribe IDs from this list: {json.dumps(all_tribe_names[:100])}...
- Be historically accurate. If uncertain, use null rather than guess.
- description should be factual, sourced from well-known historical accounts.
- For GCC tribes, focus on their role in Gulf states (UAE, Saudi, Qatar, Bahrain, Kuwait, Oman).
- Return ONLY the JSON object, no other text."""


def parse_response(text):
    """Parse JSON from Claude's response."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in response
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end])
            except json.JSONDecodeError:
                return None
    return None


def enrich_tribe(tribe, enrichment):
    """Merge enrichment data into tribe, preserving existing values."""
    for field in TRIBE_FIELDS:
        if not tribe.get(field) and enrichment.get(field):
            val = enrichment[field]
            # Validate enum fields
            if field == "formationType" and val not in VALID_FORMATION_TYPES:
                continue
            if field == "lineageRoot" and val not in VALID_LINEAGE_ROOTS:
                continue
            if field == "status" and val not in VALID_STATUS:
                continue
            if field == "alignment" and val not in VALID_ALIGNMENT:
                continue
            tribe[field] = val

    # Merge new relations
    new_rels = enrichment.get("newRelations") or []
    existing_rel_ids = {r["tribeId"] for r in tribe.get("relations", [])}
    tribe_id_set = {t["id"] for t in tribes}
    for rel in new_rels:
        if (rel.get("tribeId") and
            rel["tribeId"] in tribe_id_set and
            rel["tribeId"] not in existing_rel_ids and
            rel["tribeId"] != tribe["id"]):
            tribe["relations"].append({
                "tribeId": rel["tribeId"],
                "type": rel.get("type", "alliance"),
                "context": rel.get("context", ""),
                "strength": rel.get("strength", "moderate"),
            })
            existing_rel_ids.add(rel["tribeId"])

    return tribe


# Also define major missing tribes to add
MISSING_TRIBES = [
    {"id": "banu_hilal", "name": "Banu Hilal"},
    {"id": "banu_kinanah", "name": "Banu Kinanah"},
    {"id": "banu_abs", "name": "Banu Abs"},
    {"id": "banu_asad", "name": "Banu Asad"},
    {"id": "qudaa", "name": "Quda'a"},
    {"id": "banu_kalb", "name": "Banu Kalb"},
    {"id": "banu_amir", "name": "Banu Amir"},
    {"id": "banu_thaqif", "name": "Banu Thaqif"},
    {"id": "banu_kinda", "name": "Banu Kinda"},
    {"id": "banu_lakhm", "name": "Banu Lakhm"},
    {"id": "banu_ghassan", "name": "Banu Ghassan"},
    {"id": "banu_hanifa", "name": "Banu Hanifa"},
    {"id": "banu_shayban", "name": "Banu Shayban"},
    {"id": "banu_bakr", "name": "Banu Bakr"},
    {"id": "banu_taghlib", "name": "Banu Taghlib"},
    {"id": "banu_uqayl", "name": "Banu Uqayl"},
    {"id": "banu_murrah", "name": "Banu Murrah"},
    {"id": "banu_zayd", "name": "Banu Zayd"},
    {"id": "subay", "name": "Subay'"},
    {"id": "dawasir", "name": "Al Dawasir"},
    {"id": "al_sulaimi", "name": "Al Sulaimi"},
]

def main():
    global tribes

    # Add missing tribes first
    existing_ids = {t["id"] for t in tribes}
    added = 0
    for mt in MISSING_TRIBES:
        if mt["id"] not in existing_ids:
            tribes.append({
                "id": mt["id"],
                "name": mt["name"],
                "nameAr": None, "formationType": None, "legitimacyNotes": None,
                "ancestorName": None, "ancestorStory": None, "lineageRoot": None,
                "foundingEra": None, "originRegionId": None, "status": None,
                "peakPowerEra": None, "traditionalEconomy": None, "alignment": None,
                "description": None, "color": None, "subTribes": [], "relations": [],
            })
            added += 1
            print(f"  Added missing tribe: {mt['name']}")

    print(f"\nAdded {added} missing tribes. Total: {len(tribes)}")

    # Find tribes needing enrichment
    to_enrich = [(i, t) for i, t in enumerate(tribes) if needs_enrichment(t)]
    print(f"Tribes needing enrichment: {len(to_enrich)}/{len(tribes)}")

    all_tribe_ids = [t["id"] for t in tribes]

    enriched = 0
    failed = 0
    batch_size = 50  # Process in batches with progress saves

    for batch_start in range(0, len(to_enrich), batch_size):
        batch = to_enrich[batch_start:batch_start + batch_size]
        print(f"\n--- Batch {batch_start // batch_size + 1} ({batch_start + 1}-{min(batch_start + batch_size, len(to_enrich))}) ---")

        for idx, (tribe_idx, tribe) in enumerate(batch):
            print(f"[{batch_start + idx + 1}/{len(to_enrich)}] Enriching: {tribe['name']} ({tribe['id']})...", end=" ", flush=True)

            prompt = build_prompt(tribe, all_tribe_ids)
            response = call_claude(prompt)

            if not response:
                print("FAILED (no response)")
                failed += 1
                # Retry once after rate limit
                time.sleep(2)
                response = call_claude(prompt)
                if not response:
                    continue

            data = parse_response(response)
            if not data:
                print("FAILED (bad JSON)")
                failed += 1
                continue

            tribes[tribe_idx] = enrich_tribe(tribe, data)
            enriched += 1
            filled = sum(1 for f in TRIBE_FIELDS if tribes[tribe_idx].get(f))
            print(f"OK ({filled}/{len(TRIBE_FIELDS)} fields)")

            # Rate limit: ~50 req/min for sonnet
            time.sleep(1.2)

        # Save after each batch
        TRIBES_FILE.write_text(json.dumps(tribes, indent=2, ensure_ascii=False) + "\n")
        print(f"  Saved progress ({enriched} enriched so far)")

    # Final save
    TRIBES_FILE.write_text(json.dumps(tribes, indent=2, ensure_ascii=False) + "\n")

    # Summary
    print(f"\n{'='*50}")
    print(f"DONE: {enriched} enriched, {failed} failed, {len(tribes)} total tribes")
    filled_counts = {f: sum(1 for t in tribes if t.get(f)) for f in TRIBE_FIELDS}
    print("\nField coverage:")
    for f, c in sorted(filled_counts.items(), key=lambda x: -x[1]):
        print(f"  {f}: {c}/{len(tribes)} ({c*100//len(tribes)}%)")


if __name__ == "__main__":
    main()
