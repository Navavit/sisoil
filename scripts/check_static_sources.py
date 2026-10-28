#!/usr/bin/env python3
"""ตรวจว่าแหล่งข้อมูลที่ไม่ได้ดึงเป็นประจำมีฉบับใหม่หรือไม่ (ดูเฉพาะ metadata ไม่ดาวน์โหลดไฟล์)

- ขอบเขตจังหวัด/อำเภอ/ตำบล COD-AB (humdata) — ถ้าเปลี่ยน ต้องรัน build_boundaries.py ใหม่
- ชุดข้อมูล LDD ที่ห้ามดัดแปลง (ชุดดิน, กลุ่มชุดดิน, การใช้ที่ดิน) — เว็บให้เฉพาะลิงก์ แจ้งให้ทราบเมื่อมีฉบับใหม่

เทียบกับรอบก่อนใน data/ref/sources_state.json แล้วส่งผลให้ workflow สร้าง Issue
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "data", "ref", "sources_state.json")
UA = {"User-Agent": "SISoil/1.0 (open-data mirror; https://navavit.github.io/sisoil/)"}
# (key, ชื่อ, CKAN API, dataset id, สิ่งที่ต้องทำเมื่อเปลี่ยน)
SOURCES = [
    ("cod-ab-tha", "ขอบเขตจังหวัด/อำเภอ/ตำบล (COD-AB, humdata)", "https://data.humdata.org/api/3/action/package_show",
     "cod-ab-tha", "รัน scripts/build_boundaries.py ด้วยไฟล์ฉบับใหม่"),
    ("ldd-soilseries", "แผนที่ชุดดิน LDD", "https://lddcatalog.ldd.go.th/api/3/action/package_show", "ldd_11_01", "ตรวจลิงก์ในหน้าแหล่งข้อมูล"),
    ("ldd-soilgroup", "แผนที่กลุ่มชุดดิน LDD", "https://lddcatalog.ldd.go.th/api/3/action/package_show", "oss01", "ตรวจลิงก์ในหน้าแหล่งข้อมูล"),
    ("ldd-landuse", "แผนที่การใช้ที่ดิน LDD", "https://lddcatalog.ldd.go.th/api/3/action/package_show", "ldd_21_01", "ตรวจลิงก์ในหน้าแหล่งข้อมูล"),
]


def package(api, pid, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f"{api}?id={pid}", headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)["result"]
        except (OSError, ValueError, KeyError) as e:
            print(f"  ! {pid}: {e}", file=sys.stderr)
            time.sleep(5 * 2 ** attempt)
    return None


def version_of(p):
    """วันที่แก้ไขของชุดข้อมูลและไฟล์ล่าสุด (ไม่รวมการเข้าชม)"""
    files = [r.get("last_modified") or r.get("metadata_modified") or "" for r in p.get("resources", [])]
    return {"modified": p.get("metadata_modified"), "latest_file": max(files) if files else None,
            "license": p.get("license_title")}


def main():
    today = dt.date.today().isoformat()
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)
    changed = []
    for key, name, api, pid, action in SOURCES:
        p = package(api, pid)
        if p is None:
            print(f"{name}: ตรวจไม่ได้ (ข้าม)")
            continue
        v = version_of(p)
        old = (state.get(key) or {}).get("version")
        if old and old != v:
            changed.append({"name": name, "old": old, "new": v, "action": action})
        if not old or old != v:
            state[key] = {"version": v, "changed_at": today}
        state[key]["checked_at"] = today
        print(f"{name}: {'เปลี่ยน' if old and old != v else 'ไม่เปลี่ยน' if old else 'บันทึกครั้งแรก'} ({v['latest_file']})")
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
        f.write("\n")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        lines = [f"- **{c['name']}**: {c['old'].get('latest_file')} → {c['new'].get('latest_file')} — {c['action']}"
                 + (f" (สัญญาอนุญาตเปลี่ยนเป็น {c['new']['license']})" if c['old'].get('license') != c['new']['license'] else "")
                 for c in changed]
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"static_changed={len(changed)}\n")
            f.write("static_summary<<EOF\n" + "\n".join(lines) + "\nEOF\n")


if __name__ == "__main__":
    main()
