#!/usr/bin/env python3
"""
build-framework-seed.py - generates scaffold/db/seed/competency_framework.json from
docs/03_COMPETENCY_FRAMEWORK.md.

WHY THIS EXISTS. The seed is the framework as data, and the document is the single source of the
framework. Retyping 73 observable behaviours into JSON introduces drift that nobody can see: one
"aeroplane" spelled "airplane", one "situation" spelled "situational", and the seed no longer
byte-matches the document that governs it. docs/03 section 6 assertion 4 requires a byte match, so
the JSON is PARSED out of the document and never hand-edited.

Usage:
    python3 scaffold/scripts/build-framework-seed.py            # write the seed
    python3 scaffold/scripts/build-framework-seed.py --check    # verify the seed is current, write nothing

Exit codes: 0 ok, 1 parse or assertion failure, 2 --check found the file stale.
"""

import os
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = HERE.parent.parent                       # .../tms-kit
DOC = KIT / os.environ.get("KIT_DOCS_DIR", "kit-docs") / "03_COMPETENCY_FRAMEWORK.md"
OUT = KIT / "scaffold" / "db" / "seed" / "competency_framework.json"

EXPECTED_OB_COUNTS = [7, 7, 10, 6, 7, 11, 9, 7, 9]
EXPECTED_OB_TOTAL = 73
OB_CODE_RE = re.compile(r"^OB [0-8]\.\d{1,2}$")
COLOUR_RE = re.compile(r"^#[0-9A-F]{6}$")

# The competency table of section 2: | index | `CODE` | name | description | `#RRGGBB` |
COMPETENCY_ROW_RE = re.compile(
    r"^\|\s*(\d)\s*\|\s*`([A-Z]{3})`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*$"
)
# The per-competency headings of section 3: ### 0 · KNO - Application of Knowledge
OB_HEADING_RE = re.compile(r"^###\s+(\d)\s+·\s+([A-Z]{3})\b")
# An OB row: | OB 0.1 | text |
OB_ROW_RE = re.compile(r"^\|\s*(OB \d\.\d{1,2})\s*\|\s*(.+?)\s*\|\s*$")


def fail(message: str) -> None:
    print(f"build-framework-seed: {message}", file=sys.stderr)
    sys.exit(1)


def read_doc() -> list[str]:
    if not DOC.exists():
        fail(f"{DOC} not found; the seed cannot be generated without its source")
    return DOC.read_text(encoding="utf-8").split("\n")


def parse_competencies(lines: list[str]) -> list[dict]:
    """Section 2 only. Stops at section 3 so no other table can be mistaken for it."""
    out: list[dict] = []
    in_section = False
    for line in lines:
        if line.startswith("## 2."):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if not in_section:
            continue
        m = COMPETENCY_ROW_RE.match(line)
        if not m:
            continue
        index, code, name, description, colour = m.groups()
        out.append(
            {
                "code": code,
                "index": int(index),
                "name": name,
                "description": description,
                "colour": colour.upper(),
                "position": int(index),
                "observable_behaviours": [],
            }
        )
    return out


def parse_observable_behaviours(lines: list[str]) -> dict[str, list[dict]]:
    """Section 3 only. Keyed by competency code, in document order."""
    out: dict[str, list[dict]] = {}
    in_section = False
    current: str | None = None
    for line in lines:
        if line.startswith("## 3."):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if not in_section:
            continue
        heading = OB_HEADING_RE.match(line)
        if heading:
            current = heading.group(2)
            out.setdefault(current, [])
            continue
        row = OB_ROW_RE.match(line)
        if not row or current is None:
            continue
        code, text = row.groups()
        out[current].append({"code": code, "text": text, "position": len(out[current])})
    return out


def build() -> dict:
    lines = read_doc()
    competencies = parse_competencies(lines)
    obs = parse_observable_behaviours(lines)

    if len(competencies) != 9:
        fail(f"section 2 yielded {len(competencies)} competencies, expected 9")

    for competency in competencies:
        rows = obs.get(competency["code"])
        if rows is None:
            fail(f"section 3 has no block for competency {competency['code']}")
        competency["observable_behaviours"] = rows

    # --- assertions, mirroring docs/03 section 6 -----------------------------
    counts = [len(c["observable_behaviours"]) for c in competencies]
    if counts != EXPECTED_OB_COUNTS:
        fail(f"OB counts per competency are {counts}, expected {EXPECTED_OB_COUNTS}")
    total = sum(counts)
    if total != EXPECTED_OB_TOTAL:
        fail(f"total OB count is {total}, expected {EXPECTED_OB_TOTAL}")

    indexes = [c["index"] for c in competencies]
    if indexes != list(range(9)):
        fail(f"competency indexes are {indexes}, expected 0..8")

    seen_codes: set[str] = set()
    for competency in competencies:
        if not COLOUR_RE.match(competency["colour"]):
            fail(f"competency {competency['code']} has malformed colour {competency['colour']}")
        for ob in competency["observable_behaviours"]:
            if not OB_CODE_RE.match(ob["code"]):
                fail(f"malformed OB code {ob['code']!r}")
            if ob["code"] in seen_codes:
                fail(f"duplicate OB code {ob['code']}")
            seen_codes.add(ob["code"])
            expected_prefix = f"OB {competency['index']}."
            if not ob["code"].startswith(expected_prefix):
                fail(f"{ob['code']} sits under competency index {competency['index']}")
            if not ob["text"]:
                fail(f"{ob['code']} has empty text")

    return {
        "meta": {
            "generated_from": "docs/03_COMPETENCY_FRAMEWORK.md",
            "generated_by": "scaffold/scripts/build-framework-seed.py",
            "note": (
                "GENERATED FILE. Do not hand-edit. Change the wording in docs/03, re-run the "
                "generator, and re-seed. Hand-editing this file breaks the byte-match assertion "
                "in docs/03 section 6."
            ),
        },
        "framework": {
            # A neutral code. The framework's provenance is the document, not a named body:
            # nothing in the platform may key on who published a vocabulary.
            "code": "CBTA",
            "name": "Competency-based training and assessment framework",
            "edition": "1.0",
            "source_ref": "docs/03_COMPETENCY_FRAMEWORK.md",
            "effective_from": None,
            "is_active": True,
        },
        "expected": {
            "competency_count": 9,
            "ob_counts": EXPECTED_OB_COUNTS,
            "ob_total": EXPECTED_OB_TOTAL,
        },
        "competencies": competencies,
    }


def main() -> None:
    check_only = "--check" in sys.argv[1:]
    payload = build()
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    if check_only:
        if not OUT.exists():
            print(f"{OUT} does not exist; run without --check", file=sys.stderr)
            sys.exit(2)
        if OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT} is stale relative to {DOC}; re-run without --check", file=sys.stderr)
            sys.exit(2)
        print("competency_framework.json is current")
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    counts = [len(c["observable_behaviours"]) for c in payload["competencies"]]
    print(f"wrote {OUT.relative_to(KIT)}")
    print(f"  competencies: {len(payload['competencies'])}")
    print(f"  ob counts:    {','.join(str(c) for c in counts)} = {sum(counts)}")


if __name__ == "__main__":
    main()
