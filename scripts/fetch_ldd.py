#!/usr/bin/env python3
"""ดึงข้อมูลจุดสำรวจดินสาธารณะจากระบบ Soil Survey Public ของกรมพัฒนาที่ดิน (LDD)

ใช้เฉพาะ stored procedure แบบอ่านอย่างเดียวที่หน้าเว็บสาธารณะใช้:
  Province_List, SurveySearch_Public, SurveyDetail_Public

ผลลัพธ์:
  data/ldd/points.json     ข้อมูลหลัก (canonical) เรียงตาม h_id
  data/ldd/points.geojson  สำหรับ GIS / เว็บ
  data/ldd/points.csv      สำหรับ Excel
  data/meta.json           สรุปการอัปเดตล่าสุด
  data/changes/<date>.json รายการจุดที่เพิ่ม/ลบ/แก้ไขในรอบนี้
  data/changelog.json      ประวัติทุกรอบ

ใช้เฉพาะ Python standard library
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import statistics
import sys
import time
import urllib.request

API = "https://soilservice.ldd.go.th/SoilSurveyAPI/api/SP"
SOURCE_URL = "https://soilservice.ldd.go.th/soilsurveypublic/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
LDD = os.path.join(DATA, "ldd")

# ฟิลด์จากผลค้นหา -> ชื่อคอลัมน์ในระบบเรา
SEARCH_FIELDS = {
    "Date": "date", "Location": "location", "Zone": "utm_zone",
    "Coordinate": "coordinate", "pH": "ph", "OM": "om", "P": "p", "K": "k",
}
DETAIL_FIELDS = {
    "Subdistrict": "subdistrict", "District": "district", "Province": "province",
    "Texture Field": "texture_field", "Texture Lab": "texture_lab",
}
CSV_COLUMNS = [
    "id", "lat", "lon", "date", "first_seen", "last_seen", "detail_fetched_at", "province_code", "province", "district",
    "subdistrict", "location", "utm_zone", "utm_x", "utm_y", "coord_source", "orig_lat", "orig_lon", "ph", "om", "p",
    "k", "texture_field", "texture_lab", "qa_flags",
]


def call(sp, criteria, retries=4, delay=1.0):
    body = json.dumps({"sp": sp, "criteria": criteria}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                API, data=body, method="POST",
                headers={"Content-Type": "application/json",
                         "User-Agent": "soil-survey-db-th/1.0 (open-data mirror)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                res = json.load(r)
            time.sleep(delay)
            if not res.get("isSuccess"):
                raise RuntimeError(f"{sp}: {res.get('errors') or res.get('message')}")
            return res["data"]
        except (OSError, RuntimeError, json.JSONDecodeError) as e:  # รวม URLError, timeout, connection reset
            wait = 5 * 2 ** attempt
            print(f"  ! {sp} {criteria} failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{sp} failed after {retries} attempts")


def utm_to_latlon(x, y, zone):
    # UTM (WGS84, ซีกโลกเหนือ) -> lat/lon สูตร Transverse Mercator มาตรฐาน
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = (x - 500000) / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6
           + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(phi1)
    return math.degrees(lat), (zone - 1) * 6 - 180 + 3 + math.degrees(lon)


def in_thailand(lat, lon):
    return 5 <= lat <= 21 and 97 <= lon <= 106


FAR_DEG = 1.4  # ห่างจากค่ากลางจังหวัดเกินนี้ (~150 km) ถือว่าผิดที่


def fill_from_utm(records):
    """เติม/แก้พิกัดจาก UTM

    - จุดที่ไม่มี lat/lon: แปลงจาก UTM
    - จุดที่ LDD ให้ lat/lon มาแต่ห่างจากจังหวัดผิดปกติ: LDD แปลงด้วยโซนผิด
      (เช่น ระบุ 47 แต่ค่า X เป็นโซน 48) ถ้าแปลงด้วยอีกโซนแล้วอยู่ในจังหวัด ให้แก้
      และเก็บค่าเดิมไว้ใน orig_lat/orig_lon
    โซนที่ระบุไว้ไม่น่าเชื่อถือ จึงลองทั้ง 47 และ 48 แล้วเลือกผลที่ใกล้ค่ากลางจังหวัดที่สุด
    """
    records = list(records)
    centres = {}
    for r in records:
        if r.get("coord_source") == "ldd":
            centres.setdefault(r["province_code"], []).append((r["lat"], r["lon"]))
    centres = {k: (statistics.median(p[0] for p in v), statistics.median(p[1] for p in v))
               for k, v in centres.items()}
    for r in records:
        if not r["utm_x"] or not r["utm_y"]:
            continue
        c = centres.get(r["province_code"])
        if r["lat"] is not None:
            if r.get("coord_source") != "ldd" or not c or \
                    math.hypot(r["lat"] - c[0], r["lon"] - c[1]) <= FAR_DEG:
                continue
        stated = int(r["utm_zone"]) if str(r["utm_zone"] or "").isdigit() else None
        cands = []
        for z in (47, 48):
            lat, lon = utm_to_latlon(r["utm_x"], r["utm_y"], z)
            if in_thailand(lat, lon):
                dist = math.hypot(lat - c[0], lon - c[1]) if c else (0 if z == stated else 1)
                cands.append((dist, z, lat, lon))
        if not cands:
            continue
        dist, z, lat, lon = min(cands)
        if r["lat"] is not None:  # แก้พิกัด LDD เฉพาะเมื่อผลใหม่อยู่ในจังหวัดจริง
            if dist > FAR_DEG:
                continue
            r["orig_lat"], r["orig_lon"] = r["lat"], r["lon"]
            r["ldd_coords_fixed"] = True
        elif dist > 2.5:  # ไกลจากจังหวัดเกิน ~250 km ถือว่าไม่น่าเชื่อถือ
            continue
        r["lat"], r["lon"] = round(lat, 6), round(lon, 6)
        r["coord_source"] = "utm"
        if z != stated:
            r["utm_zone_fixed"] = z


QA_FLAGS = {
    "no_coords": "ไม่มีพิกัดที่ใช้ได้",
    "utm_converted": "พิกัดแปลงจาก UTM",
    "utm_zone_fixed": "โซน UTM ที่ระบุไม่ตรงกับค่าพิกัด",
    "ldd_coords_fixed": "lat/lon จาก LDD ผิดโซน แก้แล้ว (ค่าเดิมอยู่ใน orig_lat/orig_lon)",
    "far_from_province": "พิกัดห่างจากจังหวัดที่ระบุเกิน ~150 km",
    "province_mismatch": "จังหวัดใน location ไม่ตรงกับจังหวัดที่ค้นหา",
    "no_location": "ไม่มีชื่อตำแหน่ง",
    "date_missing": "ไม่มีวันที่หรือรูปแบบผิด",
    "date_future": "วันที่สำรวจอยู่ในอนาคต",
    "date_too_old": "วันที่สำรวจก่อนปี 1960",
    "ph_unknown": "pH เป็น Other หรือว่าง",
    "nutrient_unknown": "OM/P/K อย่างน้อยหนึ่งค่าเป็น Other หรือว่าง",
    "duplicate": "พิกัดและวันที่ซ้ำกับจุดอื่น",
}


def quality_flags(records, province_names, today):
    """ติดธงคุณภาพข้อมูลให้แต่ละจุด ไม่ลบหรือแก้ค่าต้นฉบับ"""
    records = list(records)
    centres = {}
    for r in records:
        if r.get("coord_source") == "ldd":
            centres.setdefault(r["province_code"], []).append((r["lat"], r["lon"]))
    centres = {k: (statistics.median(p[0] for p in v), statistics.median(p[1] for p in v))
               for k, v in centres.items() if len(v) >= 5}
    seen = {}
    for r in sorted(records, key=lambda x: x["id"]):
        f = []
        if r["lat"] is None:
            f.append("no_coords")
        else:
            if r.get("coord_source") == "utm":
                f.append("utm_converted")
            if r.get("utm_zone_fixed"):
                f.append("utm_zone_fixed")
            if r.get("ldd_coords_fixed"):
                f.append("ldd_coords_fixed")
            c = centres.get(r["province_code"])
            if c and math.hypot(r["lat"] - c[0], r["lon"] - c[1]) > FAR_DEG:
                f.append("far_from_province")
            key = (round(r["lat"], 5), round(r["lon"], 5), r["date"])
            if key in seen:
                f.append("duplicate")
            seen.setdefault(key, r["id"])
        loc = (r.get("location") or "").strip()
        if not loc:
            f.append("no_location")
        elif province_names.get(r["province_code"]) and \
                loc.split(",")[-1].strip().upper() != province_names[r["province_code"]].upper():
            f.append("province_mismatch")
        d = r.get("date") or ""
        if len(d) != 10 or d[4] != "-":
            f.append("date_missing")
        elif d > today:
            f.append("date_future")
        elif d < "1960-01-01":
            f.append("date_too_old")
        if r.get("ph") in (None, "", "Other"):
            f.append("ph_unknown")
        if any(r.get(k) in (None, "", "Other") for k in ("om", "p", "k")):
            f.append("nutrient_unknown")
        r["qa_flags"] = f


def province_count(code, delay):
    # สรุปตามช่วง pH ของจังหวัด ผลรวมเท่ากับจำนวนจุดทั้งหมด (ตอบกลับเล็กกว่ารายการเต็มมาก)
    data = call("DB_PieChart_Public", {"areaCode": "p" + code}, delay=delay)
    return sum(x.get("val", 0) for x in data.get("data3") or [])


def to_float(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def parse_utm(coord):
    # "X:272336.00000000, Y:1845479.00000000" หรือ "X:-, Y:-"
    out = {}
    for part in (coord or "").split(","):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip().lower()] = to_float(v.strip())
    return out.get("x"), out.get("y")


def iso_date(d):
    try:
        return dt.datetime.strptime(d, "%d/%m/%Y").date().isoformat()
    except (TypeError, ValueError):
        return d or None


def normalise(row, province_code):
    # hash ของข้อมูลดิบ ใช้ตรวจการแก้ไขที่ต้นทาง (ไม่ปนกับผลของการทำความสะอาด)
    src_hash = hashlib.sha1(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    rec = {"id": row["h_id"], "src_hash": src_hash, "lat": to_float(row.get("h_lat")),
           "lon": to_float(row.get("h_lon")), "province_code": province_code}
    for src, dst in SEARCH_FIELDS.items():
        v = row.get(src)
        rec[dst] = v.strip() if isinstance(v, str) else v
    rec["date"] = iso_date(rec["date"])
    rec["utm_x"], rec["utm_y"] = parse_utm(rec.pop("coordinate"))
    if rec["lat"] is not None and not in_thailand(rec["lat"], rec["lon"] or 0):
        rec["lat"] = rec["lon"] = None  # พิกัดนอกประเทศไทย ถือว่าไม่มีพิกัด
    rec["coord_source"] = "ldd" if rec["lat"] is not None else None
    return rec


def fingerprint(rec):
    return rec.get("src_hash")


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(path, obj, compact=False):
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-details", type=int, default=int(os.environ.get("MAX_DETAILS", 2000)),
                    help="จำนวนจุดสูงสุดที่จะดึงรายละเอียดต่อรอบ (ลดภาระเซิร์ฟเวอร์ LDD)")
    ap.add_argument("--provinces", default="", help="รหัสจังหวัดคั่นด้วยจุลภาค เช่น 40,30 (ค่าว่าง = ทั้งหมด)")
    ap.add_argument("--delay", type=float, default=1.0, help="หน่วงเวลาระหว่างคำขอ (วินาที)")
    ap.add_argument("--full", action="store_true", default=os.environ.get("FULL_REFRESH") == "true",
                    help="ดึงรายการทุกจังหวัดใหม่ แม้จำนวนจุดเท่าเดิม (ตรวจจับการแก้ไขข้อมูล)")
    args = ap.parse_args()
    os.makedirs(os.path.join(DATA, "changes"), exist_ok=True)
    os.makedirs(LDD, exist_ok=True)

    old = {r["id"]: r for r in load_json(os.path.join(LDD, "points.json"), [])}
    state_path = os.path.join(LDD, "state.json")
    state = load_json(state_path, {})
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()

    provinces = call("Province_List", {}, delay=args.delay)["data"]
    if args.provinces:
        wanted = set(args.provinces.split(","))
        provinces = [p for p in provinces if p["code"] in wanted]
    print(f"Provinces: {len(provinces)} ({'full refresh' if args.full else 'incremental'})")

    # เริ่มจากข้อมูลเดิมทั้งหมด แล้วแทนที่เฉพาะจังหวัดที่มีการเปลี่ยนแปลง
    current = dict(old)
    fetched = skipped = 0
    for p in provinces:
        code = p["code"]
        # ตรวจจำนวนจุดก่อน (คำขอเล็ก) ถ้าเท่าเดิมไม่ต้องดึงรายการซ้ำ
        count = province_count(code, args.delay)
        prev_count = state.get(code, {}).get("count")
        if not args.full and count == prev_count:
            skipped += 1
            state[code]["checked_at"] = today
            continue
        rows = call("SurveySearch_Public", {"areaCode": "p" + code, "soilName": ""}, delay=args.delay)["data"]
        current = {i: r for i, r in current.items() if r["province_code"] != code}
        for row in rows:
            rec = normalise(row, code)
            # เก็บรายละเอียดที่เคยดึงไว้แล้ว ไม่ดึงซ้ำ
            prev = old.get(rec["id"], {})
            for k in (*DETAIL_FIELDS.values(), "detail_fetched_at"):
                if k in prev:
                    rec[k] = prev[k]
            rec["first_seen"] = prev.get("first_seen", today)
            rec["last_seen"] = today
            current[rec["id"]] = rec
        fetched += 1
        # เก็บค่าจากตัวนับ (ไม่ใช่ len(rows)) เพื่อให้เทียบรอบหน้าได้ตรงกัน
        state[code] = {"name": p["label"], "count": count, "points": len(rows),
                       "checked_at": today}
        print(f"  {code} {p['label']}: {prev_count} -> {len(rows)}")
    print(f"Lists fetched: {fetched}, unchanged (skipped): {skipped}")

    # ดึงรายละเอียดเฉพาะจุดที่ยังไม่มี (ใหม่ก่อน)
    pending = [i for i in sorted(current, reverse=True) if "province" not in current[i]]
    todo = pending[: args.max_details]
    print(f"Details: {len(pending)} pending, fetching {len(todo)}")
    for n, i in enumerate(todo, 1):
        try:
            rows = call("SurveyDetail_Public", {"h_id": i}, delay=args.delay)["data"]
        except RuntimeError as e:
            print(f"  ! detail {i}: {e}", file=sys.stderr)
            continue
        d = rows[0] if rows else {}
        for src, dst in DETAIL_FIELDS.items():
            v = d.get(src)
            current[i][dst] = (v.strip() or None) if isinstance(v, str) else v
        current[i]["detail_fetched_at"] = today
        if n % 200 == 0:
            print(f"  {n}/{len(todo)}")

    fill_from_utm(current.values())
    quality_flags(current.values(), {c: v.get("name") for c, v in state.items()}, today)

    # ตรวจการเปลี่ยนแปลง
    added = sorted(set(current) - set(old))
    removed = sorted(set(old) - set(current))
    modified = sorted(i for i in set(current) & set(old) if fingerprint(current[i]) != fingerprint(old[i]))
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

    records = [current[i] for i in sorted(current)]
    write_json(os.path.join(LDD, "points.json"), records, compact=True)
    write_json(state_path, dict(sorted(state.items())))
    write_geojson(records)
    write_csv(records)

    with_coords = sum(1 for r in records if r["lat"] is not None)
    summary = {
        "date": today, "total": len(records), "added": len(added),
        "removed": len(removed), "modified": len(modified),
        "details_pending": len(pending) - len(todo),
    }
    if (added or removed or modified) and old:  # รอบแรกไม่ต้องเก็บรายการทั้งหมดซ้ำ
        write_json(os.path.join(DATA, "changes", f"{today}.json"), {
            **summary,
            "added": [current[i] for i in added],
            "removed": [old[i] for i in removed],
            "modified": [{"before": old[i], "after": current[i]} for i in modified],
        })
    log = load_json(os.path.join(DATA, "changelog.json"), [])
    log = [e for e in log if e["date"] != today] + [summary]
    write_json(os.path.join(DATA, "changelog.json"), log)
    write_json(os.path.join(DATA, "meta.json"), {
        "source": "กรมพัฒนาที่ดิน (Land Development Department) – Soil Survey Public",
        "source_url": SOURCE_URL, "updated_at": now.isoformat(),
        "total": len(records), "with_coordinates": with_coords,
        "provinces": len({r["province_code"] for r in records}),
        "details_pending": summary["details_pending"], "last_change": summary,
        "qa": {k: {"description": v, "count": sum(1 for r in records if k in r.get("qa_flags", []))}
               for k, v in QA_FLAGS.items()},
    })

    print(json.dumps(summary, ensure_ascii=False))
    # ให้ workflow ใช้ต่อ
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            for k, v in summary.items():
                f.write(f"{k}={v}\n")
            f.write(f"changed={'true' if (added or removed or modified) else 'false'}\n")


def write_geojson(records):
    feats = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(r["lon"], 6), round(r["lat"], 6)]},
        "properties": {k: v for k, v in r.items() if k not in ("lat", "lon")},
    } for r in records if r["lat"] is not None]
    write_json(os.path.join(LDD, "points.geojson"),
               {"type": "FeatureCollection", "features": feats}, compact=True)


def write_csv(records):
    with open(os.path.join(LDD, "points.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows({**r, "qa_flags": ";".join(r.get("qa_flags", []))} for r in records)


if __name__ == "__main__":
    main()
