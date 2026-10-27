#!/usr/bin/env python3
"""ดึงผลการตรวจวิเคราะห์ดิน (pH, EC, OM, P, K) จาก API ของกรมพัฒนาที่ดิน

แหล่ง: https://lddcatalog.ldd.go.th/dataset/osd01  (CC BY)
API:   https://osd101.ldd.go.th/api/data.php

ข้อจำกัดของ API ที่พบ:
  - คืนได้สูงสุด 1,000 แถวต่อคำขอ (1 แถว = 1 ค่าวัด)
  - startdate/enddate ใช้ได้ (dd/mm/yyyy พ.ศ.) แต่ parameterID ถูกละเลย
  - provinceName ใช้ร่วมกับช่วงวันที่ไม่ได้ แต่ page=2,3,... ใช้ได้ (ลำดับแถวไม่คงที่ แต่รวมทุกหน้าแล้วได้ชุดเดิม)
    จึงแตกเป็นรายวัน แล้ววันที่เกิน 1,000 แถวดึงต่อทีละหน้าจนหมด
  - ไม่มีรหัสตัวอย่าง และถ้าที่เดียวกันมีหลายตัวอย่างในวันเดียว แถวจะสลับกัน
    จับคู่ pH กับ OM ของตัวอย่างเดียวกันไม่ได้ จึงไม่สร้าง "ตัวอย่าง" ขึ้นเอง

โครงสร้างข้อมูล (data/osd/):
  measurements_<ปี>.csv.gz  ค่าวัดทีละแถวตามต้นทาง (ไม่รวม ไม่เดา)
  sites_<ปี>.json           สรุปต่อ "ที่ตั้ง+วันที่": จำนวน, ค่ากลาง, ต่ำสุด, สูงสุด ของแต่ละค่า (ใช้บนเว็บ)
  sites.csv                 sites ทุกปี
  state.json                เดือนที่ดึงแล้ว / วันที่ยังดึงไม่ครบ (capped_days จะถูกดึงใหม่ทุกรอบ)
  meta.json, changelog.json

วิธีไม่ดึงซ้ำ:
  - ขอทีละเดือน ถ้าได้ < 1,000 แถว = ครบทั้งเดือนในคำขอเดียว ถ้าเต็มจึงแตกเป็นรายวัน
  - เดือนที่เก่ากว่า RECHECK_DAYS ดึงครั้งเดียว ช่วงล่าสุดดึงซ้ำทุกรอบแล้วรวมด้วย id กันซ้ำ
"""
import argparse
import csv
import datetime as dt
import gzip
import hashlib
import html
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request

API = "https://osd101.ldd.go.th/api/data.php"
SOURCE_URL = "https://lddcatalog.ldd.go.th/dataset/osd01"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "osd")
CAP = 1000
FIRST_MONTH = (2013, 1)   # ข้อมูลเก่าสุดที่พบ (พ.ศ. 2556)
RECHECK_DAYS = 60         # ช่วงล่าสุดที่ดึงซ้ำทุกรอบ
MAX_PAGES = 50            # ต่อวัน (50,000 แถว)
FUTURE_DAYS = 120         # API มีวันที่ในอนาคต ดึงล่วงหน้าไว้ด้วยแล้วติดธง

TH_MONTHS = {m: i for i, m in enumerate(
    ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม",
     "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"], 1)}
# รหัสในวงเล็บของชื่อพารามิเตอร์ (หลังตัด HTML) -> ชื่อพารามิเตอร์ในระบบ
PARAMS = {"pH": "ph", "EC": "ec_ds_m", "OM": "om_pct", "P": "p_mg_kg", "K": "k_mg_kg"}
# ช่วงค่าที่เป็นไปได้ทางกายภาพ (นอกช่วง = ติดธง และไม่นำไปคำนวณค่าสรุป)
RANGES = {"ph": (2, 11), "ec_ds_m": (0, 50), "om_pct": (0, 100), "p_mg_kg": (0, 5000), "k_mg_kg": (0, 10000)}
PLACE = ("province", "amphur", "district", "village", "address")
QA_FLAGS = {
    "no_coords": "ไม่มีพิกัด หรือพิกัดเป็น 0",
    "outside_thailand": "พิกัดอยู่นอกประเทศไทย",
    "date_invalid": "แปลงวันที่ไม่ได้",
    "date_future": "วันที่อยู่ในอนาคต",
    "value_non_numeric": "มีค่าที่ไม่ใช่ตัวเลข (เก็บข้อความเดิมไว้)",
    "value_out_of_range": "มีค่าเกินช่วงที่เป็นไปได้ (ไม่นำไปคำนวณค่าสรุป)",
    "incomplete": "มีพารามิเตอร์ไม่ครบ 5 ค่า",
    "multi_sample": "ที่เดียวกันวันเดียวกันมีหลายตัวอย่าง (ค่าเป็นค่ากลาง)",
}
M_COLUMNS = ["id", "site_id", "date", "lat", "lon", *PLACE, "param", "value", "value_text", "first_seen", "qa_flags"]


def be(d):
    return f"{d.day:02d}/{d.month:02d}/{d.year + 543}"


def call(start, end, delay, page=1, retries=5):
    q = urllib.parse.urlencode({"startdate": be(start), "enddate": be(end), "max": CAP,
                                **({"page": page} if page > 1 else {})})
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "thai-soil-db/1.0 (open-data mirror)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read().decode("utf-8", "replace").strip()
            time.sleep(delay)
            return json.loads(body) if body else []   # ไม่มีข้อมูล = ตอบกลับว่าง
        except (OSError, json.JSONDecodeError) as e:  # รวม URLError, timeout, connection reset
            wait = 5 * 2 ** attempt
            print(f"  ! {start}..{end} failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{start}..{end} failed after {retries} attempts")


def parse_th_date(s):
    m = re.match(r"\s*(\d{1,2})\s+(\S+)\s+พ\.ศ\.\s*(\d{4})", s or "")
    if not m or m.group(2) not in TH_MONTHS:
        return None
    try:
        return dt.date(int(m.group(3)) - 543, TH_MONTHS[m.group(2)], int(m.group(1))).isoformat()
    except ValueError:
        return None


def param_of(name):
    clean = re.sub(r"<[^>]+>", "", html.unescape(name or ""))
    m = re.search(r"\((\w+)\)", clean)
    return PARAMS.get(m.group(1)) if m else None


def num(v):
    try:
        f = float(str(v).replace(",", "").strip())
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def sha(*parts):
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:16]


def to_measurements(rows):
    """แถวดิบ -> ค่าวัด (ไม่จับคู่ ไม่รวม)

    id = hash(ที่ตั้ง, วันที่, พารามิเตอร์, ค่า, ลำดับของค่าที่เหมือนกันทุกอย่าง)
    ค่าซ้ำจริง (ตัวอย่างซ้ำ) ยังถูกเก็บครบ และดึงช่วงเดิมซ้ำแล้วได้ id เดิม
    """
    seen, out = {}, []
    for r in rows:
        param = param_of(r.get("parameter"))
        if param is None:
            continue
        place = [(r.get(k) or "").strip() or None for k in PLACE]
        lat, lon = num(r.get("latitude")), num(r.get("longitude"))
        raw_value = (r.get("value") or "").strip()
        base = (r.get("date"), r.get("latitude"), r.get("longitude"), *place, param, raw_value)
        k = seen[base] = seen.get(base, -1) + 1
        value = num(raw_value)
        flags = []
        if raw_value and value is None:
            flags.append("value_non_numeric")
        if value is not None and not (RANGES[param][0] <= value <= RANGES[param][1]):
            flags.append("value_out_of_range")
        if not lat or not lon:
            lat = lon = None
        out.append({
            "id": sha(*base, k), "site_id": sha(r.get("date"), r.get("latitude"), r.get("longitude"), *place),
            "date": parse_th_date(r.get("date")), "lat": lat, "lon": lon, **dict(zip(PLACE, place)),
            "param": param, "value": value, "value_text": raw_value if value is None and raw_value else None,
            "qa_flags": flags,
        })
    return out


def build_sites(measurements, today):
    """สรุปค่าวัดต่อ ที่ตั้ง+วันที่"""
    groups = {}
    for m in measurements:
        groups.setdefault(m["site_id"], []).append(m)
    sites = []
    for sid, ms in groups.items():
        m0 = ms[0]
        s = {"id": sid, "date": m0["date"], "lat": m0["lat"], "lon": m0["lon"],
             **{k: m0[k] for k in PLACE}, "first_seen": min(m["first_seen"] for m in ms)}
        n_max, flags = 0, set()
        for param in PARAMS.values():
            vals = [m["value"] for m in ms if m["param"] == param and m["value"] is not None
                    and "value_out_of_range" not in m["qa_flags"]]
            n = sum(1 for m in ms if m["param"] == param)
            n_max = max(n_max, n)
            s[param] = round(statistics.median(vals), 3) if vals else None
            if len(vals) > 1:
                s[param + "_min"], s[param + "_max"] = min(vals), max(vals)
            s[param + "_n"] = n
            if n == 0:
                flags.add("incomplete")
        s["n_samples"] = n_max
        for m in ms:
            flags.update(m["qa_flags"])
        if n_max > 1:
            flags.add("multi_sample")
        if s["lat"] is None:
            flags.add("no_coords")
        elif not (5 <= s["lat"] <= 21 and 97 <= s["lon"] <= 106):
            flags.add("outside_thailand")
        if s["date"] is None:
            flags.add("date_invalid")
        elif s["date"] > today:
            flags.add("date_future")
        s["qa_flags"] = [f for f in QA_FLAGS if f in flags]
        sites.append(s)
    return sites


def month_range(y, m):
    start = dt.date(y, m, 1)
    return start, dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)


def fetch_window(start, end, delay, state):
    """ดึงช่วงวันที่ ถ้าเต็ม 1,000 แถวให้แตกเป็นรายวัน วันเดียวที่เต็มดึงหน้าถัดไปจนหมด"""
    rows = call(start, end, delay)
    if len(rows) < CAP:
        return rows
    if start == end:
        page, last = 1, rows
        while len(last) == CAP and page < MAX_PAGES:
            page += 1
            last = call(start, end, delay, page)
            rows += last
        if len(last) == CAP:
            state["capped_days"][start.isoformat()] = len(rows)
        else:
            state["capped_days"].pop(start.isoformat(), None)
        return rows
    out, d = [], start
    while d <= end:
        out += fetch_window(d, d, delay, state)
        d += dt.timedelta(days=1)
    return out


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(path, obj, compact=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, **({"separators": (",", ":")} if compact else {"indent": 1}))
        f.write("\n")


def read_measurements():
    out = {}
    for f in sorted(os.listdir(OUT)):
        if not re.match(r"measurements_\d{4}\.csv\.gz$", f):
            continue
        with gzip.open(os.path.join(OUT, f), "rt", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                m = {k: (v if v != "" else None) for k, v in r.items()}
                m["lat"], m["lon"], m["value"] = num(r["lat"]), num(r["lon"]), num(r["value"])
                m["qa_flags"] = [x for x in r["qa_flags"].split(";") if x]
                out[m["id"]] = m
    return out


def write_measurements(by_year):
    for yr, ms in by_year.items():
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=M_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for m in sorted(ms, key=lambda m: (m["date"] or "", m["site_id"], m["param"], m["id"])):
            w.writerow({**m, "qa_flags": ";".join(m["qa_flags"])})
        # mtime=0 ให้ไฟล์เหมือนเดิมทุกไบต์ถ้าข้อมูลไม่เปลี่ยน (git ไม่เห็นว่าแก้)
        with open(os.path.join(OUT, f"measurements_{yr}.csv.gz"), "wb") as f:
            with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
                gz.write(buf.getvalue().encode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-months", type=int, default=int(os.environ.get("OSD_MAX_MONTHS", 24)),
                    help="จำนวนเดือนย้อนหลัง (backfill) สูงสุดต่อรอบ")
    ap.add_argument("--delay", type=float, default=1.5)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.date()
    state = load_json(os.path.join(OUT, "state.json"), {"months_done": {}, "capped_days": {}})
    old = read_measurements()

    # 1) เดือนที่ยังไม่เคยดึง (backfill) จากใหม่ไปเก่า จำกัดจำนวนต่อรอบ
    recheck_from = today - dt.timedelta(days=RECHECK_DAYS)
    todo, (y, m) = [], FIRST_MONTH
    while dt.date(y, m, 1) <= recheck_from:
        if f"{y:04d}-{m:02d}" not in state["months_done"]:
            todo.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    todo = list(reversed(todo))[: args.max_months]
    windows = [(month_range(y, m), f"{y:04d}-{m:02d}") for y, m in todo]
    # 2) ช่วงล่าสุด + อนาคต: ดึงซ้ำทุกรอบ
    windows.append(((recheck_from.replace(day=1), today + dt.timedelta(days=FUTURE_DAYS)), None))
    # 3) วันที่เคยดึงไม่ครบ (ก่อนรองรับ page หรือยังเกิน MAX_PAGES) ดึงใหม่
    windows += [((d, d), None) for d in map(dt.date.fromisoformat, state["capped_days"])
                if d < recheck_from.replace(day=1)]
    print(f"Backfill months: {len(todo)} | recent window: {windows[-1][0][0]}..{windows[-1][0][1]}")

    fetched = {}
    for (start, end), month_key in windows:
        rows = fetch_window(start, end, args.delay, state)
        for mm in to_measurements(rows):
            fetched[mm["id"]] = mm
        if month_key:
            state["months_done"][month_key] = {"rows": len(rows), "checked_at": today.isoformat()}
        print(f"  {start}..{end}: {len(rows)} rows")

    added = [i for i in fetched if i not in old]
    for i, mm in fetched.items():
        mm["first_seen"] = (old.get(i) or {}).get("first_seen") or today.isoformat()
    merged = {**old, **fetched}

    by_year = {}
    for mm in merged.values():
        by_year.setdefault((mm["date"] or "0000")[:4], []).append(mm)
    write_measurements(by_year)

    sites = build_sites(merged.values(), today.isoformat())
    sites_by_year = {}
    for s in sites:
        sites_by_year.setdefault((s["date"] or "0000")[:4], []).append(s)
    for yr, ss in sites_by_year.items():
        write_json(os.path.join(OUT, f"sites_{yr}.json"), sorted(ss, key=lambda s: (s["date"] or "", s["id"])), compact=True)
    cols = ["id", "date", "lat", "lon", *PLACE, "n_samples",
            *[c for p in PARAMS.values() for c in (p, p + "_n", p + "_min", p + "_max")], "first_seen", "qa_flags"]
    with open(os.path.join(OUT, "sites.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for s in sorted(sites, key=lambda s: (s["date"] or "", s["id"])):
            w.writerow({**s, "qa_flags": ";".join(s["qa_flags"])})

    state["months_done"] = dict(sorted(state["months_done"].items()))
    state["capped_days"] = dict(sorted(state["capped_days"].items()))
    write_json(os.path.join(OUT, "state.json"), state)
    months_total = (recheck_from.year - FIRST_MONTH[0]) * 12 + recheck_from.month - FIRST_MONTH[1] + 1
    summary = {"date": today.isoformat(), "measurements": len(merged), "sites": len(sites), "added": len(added)}
    log = [e for e in load_json(os.path.join(OUT, "changelog.json"), []) if e["date"] != today.isoformat()] + [summary]
    write_json(os.path.join(OUT, "changelog.json"), log)
    write_json(os.path.join(OUT, "meta.json"), {
        "source": "กรมพัฒนาที่ดิน – การตรวจวิเคราะห์ดิน (osd01)", "source_url": SOURCE_URL, "license": "CC BY",
        "updated_at": now.isoformat(), "measurements": len(merged), "sites": len(sites),
        "sites_with_coordinates": sum(1 for s in sites if s["lat"] is not None),
        "years": sorted(y for y in sites_by_year if y != "0000"),
        "backfill": {"months_done": len(state["months_done"]), "months_total": months_total},
        "capped_days": len(state["capped_days"]),
        "qa": {k: {"description": v, "sites": sum(1 for s in sites if k in s["qa_flags"])} for k, v in QA_FLAGS.items()},
    })
    print(json.dumps(summary, ensure_ascii=False))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"osd_added={len(added)}\nosd_total={len(merged)}\n")


if __name__ == "__main__":
    main()
