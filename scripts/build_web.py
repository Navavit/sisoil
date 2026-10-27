#!/usr/bin/env python3
"""สร้างไฟล์ย่อสำหรับเว็บ (ฟังก์ชันตรวจดินจากพิกัด) จากข้อมูลใน data/

ไม่ดึงข้อมูลใหม่ อ่านเฉพาะไฟล์ที่มีอยู่ แล้วแบ่งเป็นช่องกริด 0.5° ให้เว็บโหลดเฉพาะบริเวณที่เลือก
สร้างตอน deploy (ไม่ commit) — data/web/ อยู่ใน .gitignore

data/web/grid/<i>_<j>.json   i = floor(lat*2), j = floor(lon*2)
  ldd:   [id, lat, lon, date, ph, om, p, k, texture]          (ระดับตามต้นทาง)
  osd:   [lat, lon, first_date, last_date, n_dates, ph, ec, om, p, k]   (ค่ากลางข้ามวันที่ ณ พิกัดเดียวกัน)
  wosis: [id, code, lat, lon, date, ph, oc, clay, sand]       (เฉลี่ย 0–30 cm)
  gee:   [lat, lon, *ค่าตาม gee_cols ใน index.json]
data/web/dindee.json         บัตรดินดีรายตำบล: จำนวนตัวอย่างต่อระดับ pH/N/P/K
data/web/index.json          รายชื่อช่องกริดที่มีข้อมูล และชื่อคอลัมน์ gee
"""
import collections
import csv
import glob
import json
import math
import os
import shutil
import statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "web")
OSD_PARAMS = ["ph", "ec_ds_m", "om_pct", "p_mg_kg", "k_mg_kg"]
WOSIS_COLS = ["ph_h2o_0_30", "orgc_g_kg_0_30", "clay_pct_0_30", "sand_pct_0_30"]


def cell(lat, lon):
    return f"{math.floor(lat * 2)}_{math.floor(lon * 2)}"


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def main():
    grid = collections.defaultdict(lambda: {"ldd": [], "osd": [], "wosis": [], "gee": []})

    for p in load(os.path.join(DATA, "ldd", "points.json"), []):
        if p.get("lat") is None or "far_from_province" in p.get("qa_flags", []):
            continue
        grid[cell(p["lat"], p["lon"])]["ldd"].append(
            [p["id"], p["lat"], p["lon"], p.get("date"), p.get("ph"), p.get("om"), p.get("p"), p.get("k"),
             p.get("texture_lab") or p.get("texture_field")])

    osd = collections.defaultdict(list)
    for f in glob.glob(os.path.join(DATA, "osd", "sites_*.json")):
        for s in load(f, []):
            if s.get("lat") is not None and "outside_thailand" not in s.get("qa_flags", []):
                osd[(round(s["lat"], 5), round(s["lon"], 5))].append(s)
    for (lat, lon), ss in osd.items():
        dates = sorted(s["date"] for s in ss if s.get("date"))
        med = [(lambda v: round(statistics.median(v), 2) if v else None)([s[k] for s in ss if s.get(k) is not None])
               for k in OSD_PARAMS]
        grid[cell(lat, lon)]["osd"].append([lat, lon, dates[0] if dates else None, dates[-1] if dates else None, len(ss), *med])

    for s in load(os.path.join(DATA, "wosis", "profiles.json"), []):
        if s.get("lat") is None or s.get("duplicate_of") or "outside_thailand" in s.get("qa_flags", []):
            continue
        grid[cell(s["lat"], s["lon"])]["wosis"].append(
            [s["id"], s.get("code"), s["lat"], s["lon"], s.get("date"), *[s.get(c) for c in WOSIS_COLS]])

    gee_cols = []
    path = os.path.join(DATA, "gee", "covariates.csv")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            rd = csv.DictReader(f)
            gee_cols = [c for c in rd.fieldnames if c not in ("source", "id", "lat", "lon")]
            seen = set()
            for r in rd:
                lat, lon = num(r["lat"]), num(r["lon"])
                if lat is None or (round(lat, 4), round(lon, 4)) in seen:
                    continue
                seen.add((round(lat, 4), round(lon, 4)))
                grid[cell(lat, lon)]["gee"].append([lat, lon, *[num(r[c]) for c in gee_cols]])

    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "grid"))
    for key, g in grid.items():
        write_json(os.path.join(OUT, "grid", f"{key}.json"), g)

    tambons = collections.defaultdict(lambda: {"n": 0, "ph": collections.Counter(), "n_": collections.Counter(),
                                              "p": collections.Counter(), "k": collections.Counter(), "dates": []})
    path = os.path.join(DATA, "dindee", "samples.csv")
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                t = tambons[f"{r['province']}|{r['amphoe']}|{r['tambon']}"]
                t["n"] += 1
                for k, col in (("ph", "ph_class"), ("n_", "n_class"), ("p", "p_class"), ("k", "k_class")):
                    if r[col]:
                        t[k][r[col]] += 1
                if r["date"]:
                    t["dates"].append(r["date"])
    write_json(os.path.join(OUT, "dindee.json"), {
        key: {"n": t["n"], "ph": t["ph"], "n_": t["n_"], "p": t["p"], "k": t["k"],
              "from": min(t["dates"], default=None), "to": max(t["dates"], default=None)}
        for key, t in tambons.items()})

    write_json(os.path.join(OUT, "index.json"), {"cells": sorted(grid), "gee_cols": gee_cols, "cell_deg": 0.5})
    total = {k: sum(len(g[k]) for g in grid.values()) for k in ("ldd", "osd", "wosis", "gee")}
    print(f"cells: {len(grid)} | {total} | dindee tambons: {len(tambons)}")


if __name__ == "__main__":
    main()
