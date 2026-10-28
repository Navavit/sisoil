#!/usr/bin/env python3
"""ดึง soil profile และผลแล็บของประเทศไทยจาก ISRIC WoSIS (ชุด "latest")

แหล่ง: https://www.isric.org/explore/wosis
API:   WFS https://maps.isric.org/mapserv?map=/map/wosis_latest.map
สัญญาอนุญาต: ระบุต่อชุดข้อมูลย่อย (dataset_id) ทุกชุดของไทยที่พบเป็น CC BY / CC0 / U.S. Public Domain
             ชุดที่เป็น NC หรือ ND จะถูกตัดออก (repo เป็นสาธารณะ)

โครงสร้างข้อมูล (data/wosis/):
  profiles.json   profile + ชั้นดิน + ค่าเฉลี่ยถ่วงความลึก 0–30 cm (ใช้บนเว็บ)
  profiles.csv    ระดับ profile (ไม่รวมชั้นดิน)
  layers.csv      ค่าวัดทีละ ชั้นดิน × คุณสมบัติ ตามต้นทาง (พร้อมวิธีวิเคราะห์และสัญญาอนุญาต)
  meta.json, changelog.json

WoSIS ปรับปรุงเป็นรอบ (ไม่บ่อย) ดึงใหม่ทั้งหมดทุกครั้ง (ไม่กี่ MB) แล้วเทียบกับรอบก่อนด้วย hash ของแต่ละ profile
"""
import csv
import datetime as dt
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import admin

WFS = "https://maps.isric.org/mapserv?map=/map/wosis_latest.map"
SOURCE_URL = "https://www.isric.org/explore/wosis"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "wosis")
COUNTRY = "Thailand"

# (ชั้นข้อมูล WFS, ชื่อคอลัมน์, หน่วย, ช่วงที่เป็นไปได้ทางกายภาพ)
PROPS = [
    ("phaq", "ph_h2o", "", (2, 11)),
    ("phkc", "ph_kcl", "", (2, 11)),
    ("orgc", "orgc_g_kg", "g/kg", (0, 600)),
    ("nitkjd", "n_g_kg", "g/kg", (0, 50)),
    ("clay", "clay_pct", "%", (0, 100)),
    ("silt", "silt_pct", "%", (0, 100)),
    ("sand", "sand_pct", "%", (0, 100)),
    ("cecph7", "cec_cmol_kg", "cmol(c)/kg", (0, 300)),
    ("bdfiod", "bd_kg_dm3", "kg/dm3", (0.1, 2.6)),
    ("elco25", "ec_ds_m", "dS/m", (0, 100)),
]
TOP = 30   # ความลึก (cm) ของค่าสรุปผิวดิน
QA_FLAGS = {
    "no_coords": "ไม่มีพิกัด",
    "outside_thailand": "พิกัดอยู่นอกประเทศไทย",
    "no_date": "ไม่ระบุปีที่สำรวจ",
    "value_out_of_range": "มีค่าเกินช่วงที่เป็นไปได้ (ไม่นำไปคำนวณค่าสรุป)",
    "no_lab_data": "ไม่มีผลแล็บในคุณสมบัติที่ดึง",
    "duplicate": "profile เดียวกับอีก profile ใน WoSIS (ดู duplicate_of) — ไม่แสดงบนแผนที่ ไม่นับซ้ำ",
    "near_ldd_point": "อยู่ใกล้จุดสำรวจ LDD ในปีเดียวกัน อาจเป็นจุดเดียวกัน (ดู ldd_match)",
    "shared_coords": "พิกัดซ้ำกับ profile อื่นหรือแหล่งอื่น ระบุตำแหน่งจริงไม่ได้ (ไม่แสดงบนแผนที่)",
    "off_land": "พิกัดไม่อยู่บนบก (ห่างฝั่งเกิน 1 km, ไม่แสดงบนแผนที่)",
}
# ลำดับความน่าเชื่อถือเมื่อ profile เดียวกันอยู่หลายชุด: แหล่งต้นฉบับก่อนชุดที่รวบรวมต่อ
DATASET_PRIORITY = ["US-NCSS", "WD-ISIS", "WD-WISE"]
DUP_M = 100        # ข้ามชุดข้อมูล: ห่างไม่เกินนี้ + ปีเดียวกัน + มีชั้นความลึกตรงกัน = profile เดียวกัน
LDD_NEAR_M = 250   # เทียบ LDD: ห่างไม่เกินนี้ + ปีเดียวกัน (LDD แปลงจาก UTM คลาดได้หลายร้อยเมตร)
P_COLUMNS = ["id", "code", "dataset", "date", "lat", "lon", "positional_uncertainty", "licence",
             "wrb_group", "usda_order", "n_layers", "adm_tambon", "duplicate_of", "ldd_match_id", "ldd_match_m", *[f"{c}_0_{TOP}" for _, c, *_ in PROPS], "first_seen", "qa_flags"]
L_COLUMNS = ["profile_id", "layer_id", "layer_name", "upper_depth", "lower_depth", "property", "value",
             "value_raw", "method", "dataset", "licence", "qa_flags"]


def get(layer, retries=5):
    q = urllib.parse.urlencode({
        "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": f"ms:wosis_latest_{layer}",
        "FILTER": f"<Filter><PropertyIsEqualTo><PropertyName>country_name</PropertyName>"
                  f"<Literal>{COUNTRY}</Literal></PropertyIsEqualTo></Filter>",
        "OUTPUTFORMAT": "application/json; subtype=geojson",
    })
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f"{WFS}&{q}", headers={"User-Agent": "thai-soil-db/1.0 (open-data mirror)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                features = json.loads(r.read())["features"]
            time.sleep(1)
            return [f["properties"] for f in features]
        except (OSError, ValueError, KeyError) as e:
            wait = 5 * 2 ** attempt
            print(f"  ! {layer} failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{layer} failed after {retries} attempts")


def open_licence(lic):
    """NC/ND เผยแพร่ซ้ำใน repo สาธารณะไม่ได้"""
    l = (lic or "").upper()
    return not any(x in l for x in ("NONCOMMERCIAL", "NON-COMMERCIAL", "NODERIV", "NO DERIV", "BY-NC", "BY-ND"))


def short_licence(lic):
    return (lic or "").split(",")[0].split(" http")[0].strip() or None


def profile_date(p):
    y, m, d = p.get("year"), p.get("month"), p.get("day")
    if not y:
        return None
    return f"{int(y):04d}" + (f"-{int(m):02d}" if m else "") + (f"-{int(d):02d}" if m and d else "")


def weighted_top(layers, col):
    """ค่าเฉลี่ยถ่วงด้วยความหนาของชั้นที่ซ้อนกับ 0–TOP cm"""
    total = weight = 0.0
    for ly in layers:
        v, u, l = ly.get(col), ly.get("u"), ly.get("l")
        if v is None or u is None or l is None or l <= u:
            continue
        w = max(0, min(l, TOP) - max(u, 0))
        total, weight = total + v * w, weight + w
    return round(total / weight, 2) if weight else None


def dist_m(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def same_year(a, b):
    """ปีตรงกัน หรือฝั่งใดฝั่งหนึ่งไม่มีปี"""
    return not a or not b or a[:4] == b[:4]


def rank(s):
    d = s["dataset"]
    return (DATASET_PRIORITY.index(d) if d in DATASET_PRIORITY else len(DATASET_PRIORITY), s["id"])


def find_duplicates(profiles):
    """คืน {id ที่ซ้ำ: id ที่เก็บไว้}

    (ก) ต่างชุดข้อมูล: ห่าง <= DUP_M, ปีเดียวกัน, มีช่วงความลึกตรงกันอย่างน้อย 1 ชั้น
    (ข) ชุดเดียวกัน: พิกัดเดียวกัน (< 1 m) และค่าทุกชั้นเหมือนกันทุกตัว (นำเข้าซ้ำ)
    """
    parent, by_id = {}, {s["id"]: s for s in profiles}

    def root(i):
        while i in parent:
            i = parent[i]
        return i

    def depths(s):
        return {(ly["u"], ly["l"]) for ly in s["layers"]}

    def values(s):
        return [{k: v for k, v in ly.items() if k != "name"} for ly in s["layers"]]

    pts = [s for s in profiles if s["lat"] is not None]
    for i, a in enumerate(pts):
        for b in pts[i + 1:]:
            if abs(a["lat"] - b["lat"]) > 0.002 or abs(a["lon"] - b["lon"]) > 0.002:
                continue
            d = dist_m(a["lat"], a["lon"], b["lat"], b["lon"])
            if a["dataset"] != b["dataset"]:
                dup = d <= DUP_M and same_year(a["date"], b["date"]) and depths(a) & depths(b)
            else:
                dup = d < 1 and a["layers"] and values(a) == values(b)
            if dup:
                ra, rb = root(a["id"]), root(b["id"])
                if ra != rb:
                    keep, drop = sorted([ra, rb], key=lambda i: rank(by_id[i]))
                    parent[drop] = keep
    return {i: root(i) for i in parent}


def ldd_matches(profiles):
    """จุด LDD ที่ใกล้ที่สุดในปีเดียวกัน (ภายใน LDD_NEAR_M)"""
    path = os.path.join(ROOT, "data", "ldd", "points.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        ldd = [p for p in json.load(f) if p.get("lat") is not None and "far_from_province" not in p.get("qa_flags", [])]
    out = {}
    for s in profiles:
        if s["lat"] is None:
            continue
        best = None
        for p in ldd:
            if abs(p["lat"] - s["lat"]) > 0.005 or abs(p["lon"] - s["lon"]) > 0.005:
                continue
            d = dist_m(s["lat"], s["lon"], p["lat"], p["lon"])
            if d <= LDD_NEAR_M and same_year(s["date"], p.get("date")) and (best is None or d < best[0]):
                best = (d, p["id"])
        if best:
            out[s["id"]] = {"id": best[1], "distance_m": round(best[0])}
    return out


def sha(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(path, obj, compact=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, **({"separators": (",", ":")} if compact else {"indent": 1}))
        f.write("\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.date().isoformat()
    old = {p["id"]: p for p in load_json(os.path.join(OUT, "profiles.json"), [])}

    raw_profiles = get("profiles")
    print(f"profiles: {len(raw_profiles)}")
    measurements, excluded = [], {}
    for layer, col, _, (lo, hi) in PROPS:
        rows = get(layer)
        print(f"  {layer}: {len(rows)} rows")
        for r in rows:
            if not open_licence(r.get("licence")):
                excluded[r.get("dataset_id")] = r.get("licence")
                continue
            v = r.get("value_avg")
            measurements.append({
                "profile_id": r["profile_id"], "layer_id": r["layer_id"], "layer_name": r.get("layer_name") or None,
                "upper_depth": r.get("upper_depth"), "lower_depth": r.get("lower_depth"),
                "property": col, "value": v, "value_raw": r.get("value"),
                "method": (r.get("method_options") or "").strip("{}\"") or None,
                "dataset": r.get("dataset_id"), "licence": short_licence(r.get("licence")),
                "qa_flags": ["value_out_of_range"] if v is not None and not (lo <= v <= hi) else [],
            })

    # ชั้นดินต่อ profile: {layer_id: {u, l, name, <col>: ค่า}}
    layers_by_profile = {}
    licences = {}
    for m in measurements:
        ly = layers_by_profile.setdefault(m["profile_id"], {}).setdefault(
            m["layer_id"], {"u": m["upper_depth"], "l": m["lower_depth"], "name": m["layer_name"]})
        if not m["qa_flags"]:
            ly[m["property"]] = m["value"]
        else:
            ly.setdefault("flags", []).append(m["property"])
        licences.setdefault(m["profile_id"], set()).add(m["licence"])

    profiles = []
    for p in raw_profiles:
        pid = p["profile_id"]
        layers = sorted(layers_by_profile.get(pid, {}).values(), key=lambda x: (x["u"] if x["u"] is not None else 999))
        lat, lon = p.get("latitude"), p.get("longitude")
        s = {
            "id": pid, "code": p.get("profile_code"), "dataset": p.get("dataset_code"), "date": profile_date(p),
            "lat": round(lat, 6) if lat is not None else None, "lon": round(lon, 6) if lon is not None else None,
            "positional_uncertainty": p.get("positional_uncertainty") or None,
            "licence": "; ".join(sorted(x for x in licences.get(pid, ()) if x)) or None,
            "wrb_group": p.get("wrb_reference_soil_group") or None, "usda_order": p.get("usda_order_name") or None,
            "n_layers": len(layers),
            **{f"{c}_0_{TOP}": weighted_top(layers, c) for _, c, *_ in PROPS},
            "layers": layers,
        }
        flags = set()
        if s["lat"] is None:
            flags.add("no_coords")
        elif not (5 <= s["lat"] <= 21 and 97 <= s["lon"] <= 106):
            flags.add("outside_thailand")
        else:
            # ตำบล/อำเภอ/จังหวัดจากขอบเขต humdata (COD-AB) — ใช้เป็นชื่อพื้นที่หลักทุกชั้น
            where = admin.locate(s["lat"], s["lon"])
            s["adm_tambon"] = where and where["tambon"]
            if where is None and admin.nearest_province(s["lat"], s["lon"])[0] > admin.TOL_KM:
                flags.add("off_land")
        if not s["date"]:
            flags.add("no_date")
        if any(ly.get("flags") for ly in layers):
            flags.add("value_out_of_range")
        if not layers:
            flags.add("no_lab_data")
        s["qa_flags"] = sorted(flags)
        profiles.append(s)
    profiles.sort(key=lambda s: s["id"])

    dups, near = find_duplicates(profiles), ldd_matches(profiles)
    shared = admin.shared_coords("wosis", [s for s in profiles if not dups.get(s["id"])])
    for s in profiles:
        flags = set(s["qa_flags"])
        s["duplicate_of"] = dups.get(s["id"])
        s["ldd_match"] = near.get(s["id"])
        if s["duplicate_of"]:
            flags.add("duplicate")
        if s["ldd_match"]:
            flags.add("near_ldd_point")
        if not s["duplicate_of"] and s["lat"] is not None and admin.coord_key(s["lat"], s["lon"]) in shared:
            flags.add("shared_coords")
        s["qa_flags"] = [f for f in QA_FLAGS if f in flags]
        s["hash"] = sha({k: v for k, v in s.items() if k != "hash"})
        s["first_seen"] = (old.get(s["id"]) or {}).get("first_seen") or today

    new_ids = {s["id"] for s in profiles}
    added = [s["id"] for s in profiles if s["id"] not in old]
    removed = [i for i in old if i not in new_ids]
    modified = [s["id"] for s in profiles if s["id"] in old and old[s["id"]].get("hash") != s["hash"]]

    write_json(os.path.join(OUT, "profiles.json"), profiles, compact=True)
    with open(os.path.join(OUT, "profiles.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=P_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for s in profiles:
            m = s["ldd_match"] or {}
            w.writerow({**s, "ldd_match_id": m.get("id"), "ldd_match_m": m.get("distance_m"),
                        "qa_flags": ";".join(s["qa_flags"])})
    with open(os.path.join(OUT, "layers.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=L_COLUMNS)
        w.writeheader()
        for m in sorted(measurements, key=lambda m: (m["profile_id"], m["upper_depth"] or 0, m["layer_id"], m["property"])):
            w.writerow({**m, "qa_flags": ";".join(m["qa_flags"])})

    summary = {"date": today, "total": len(profiles), "added": len(added), "removed": len(removed), "modified": len(modified)}
    log = [e for e in load_json(os.path.join(OUT, "changelog.json"), []) if e["date"] != today] + [summary]
    write_json(os.path.join(OUT, "changelog.json"), log)
    write_json(os.path.join(OUT, "meta.json"), {
        "source": "ISRIC – WoSIS (latest)", "source_url": SOURCE_URL, "api": WFS,
        "license": "ต่อชุดข้อมูล: " + ", ".join(sorted({m["licence"] for m in measurements if m["licence"]})),
        "updated_at": now.isoformat(), "profiles": len(profiles), "measurements": len(measurements),
        "profiles_with_coordinates": sum(1 for s in profiles if s["lat"] is not None),
        "unique_profiles": sum(1 for s in profiles if not s["duplicate_of"]),
        "dedup_rules": {"cross_dataset_m": DUP_M, "same_dataset": "identical layers at same point",
                        "priority": DATASET_PRIORITY, "ldd_near_m": LDD_NEAR_M},
        "datasets": {d: sum(1 for s in profiles if s["dataset"] == d) for d in sorted({s["dataset"] for s in profiles})},
        "excluded_datasets": excluded,
        "properties": {c: {"wfs_layer": l, "unit": u, "range": list(r)} for l, c, u, r in PROPS},
        "topsoil_depth_cm": TOP,
        "qa": {k: {"description": v, "profiles": sum(1 for s in profiles if k in s["qa_flags"])} for k, v in QA_FLAGS.items()},
    })
    print(json.dumps(summary, ensure_ascii=False))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"wosis_added={len(added)}\nwosis_total={len(profiles)}\n")


if __name__ == "__main__":
    main()
