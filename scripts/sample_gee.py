#!/usr/bin/env python3
"""สุ่มค่าคุณสมบัติดินจาก Google Earth Engine ที่ตำแหน่งจุดสำรวจ/ตัวอย่างดิน

ชั้นข้อมูล (raster คงที่ ไม่ต้องดึงซ้ำ — สุ่มเฉพาะจุดที่ยังไม่เคยสุ่ม):
  OpenLandMap v02 (CC BY-SA 4.0): pH(H2O), อินทรีย์คาร์บอน, ดินเหนียว, ทราย, ชั้นเนื้อดิน USDA
  SoilGrids 2.0 (CC BY 4.0):      pH(H2O), SOC, clay, sand ที่ 0–5 cm
  FAO GSOCmap v1.5 (CC BY):       SOC stock 0–30 cm (t/ha, ~1 km) ผ่าน GEE community catalog

ผลลัพธ์: data/gee/covariates.csv (key = source + id; osd ใช้พิกัดเป็น id เพราะที่เดียวกันวิเคราะห์ได้หลายวัน)

ยืนยันตัวตน:
  ในเครื่อง:      earthengine authenticate  แล้วตั้ง EE_PROJECT=<cloud project id>
  ในเครื่อง (service account): EE_PROJECT และ EE_KEY_FILE ใน .env
  GitHub Actions: service account (secret) หรือ Workload Identity Federation + EE_PROJECT
ต้องติดตั้ง: pip install earthengine-api
"""
import argparse
import csv
import glob
import json
import os
import sys

import ee

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "gee")
OUT_CSV = os.path.join(OUT, "covariates.csv")
BATCH = 2000

# (ชื่อคอลัมน์, asset, band, ตัวคูณให้เป็นหน่วยจริง)
LAYERS = [
    ("olm_ph_0cm", "OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02", "b0", 0.1),
    ("olm_ph_30cm", "OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02", "b30", 0.1),
    ("olm_oc_g_kg_0cm", "OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02", "b0", 5),
    ("olm_clay_pct_0cm", "OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02", "b0", 1),
    ("olm_sand_pct_0cm", "OpenLandMap/SOL/SOL_SAND-WFRACTION_USDA-3A1A1A_M/v02", "b0", 1),
    ("olm_texture_class_0cm", "OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02", "b0", 1),
    ("sg_ph_0_5cm", "projects/soilgrids-isric/phh2o_mean", "phh2o_0-5cm_mean", 0.1),
    ("sg_soc_g_kg_0_5cm", "projects/soilgrids-isric/soc_mean", "soc_0-5cm_mean", 0.1),
    ("sg_clay_pct_0_5cm", "projects/soilgrids-isric/clay_mean", "clay_0-5cm_mean", 0.1),
    ("sg_sand_pct_0_5cm", "projects/soilgrids-isric/sand_mean", "sand_0-5cm_mean", 0.1),
    ("gsoc_t_ha_0_30cm", "projects/sat-io/open-datasets/FAO/GSOCMAP1-5-0", "b1", 1),
]
COLUMNS = ["source", "id", "lat", "lon", *[c for c, *_ in LAYERS]]


def load_dotenv(path=os.path.join(ROOT, ".env")):
    """อ่าน .env แบบ KEY=VALUE (ไม่ทับตัวแปรที่ตั้งไว้แล้ว)"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), os.path.expanduser(v.strip().strip("\"'")))


def init():
    load_dotenv()
    project = os.environ.get("EE_PROJECT")
    key = os.environ.get("EE_SERVICE_ACCOUNT_KEY")
    if not key and os.environ.get("EE_KEY_FILE"):
        with open(os.environ["EE_KEY_FILE"], encoding="utf-8") as f:
            key = f.read()
    if key:
        info = json.loads(key)
        creds = ee.ServiceAccountCredentials(info["client_email"], key_data=key)
        ee.Initialize(creds, project=project or info.get("project_id"))
    elif os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        # credential ชั่วคราวจาก google-github-actions/auth (Workload Identity Federation)
        import google.auth
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/earthengine",
                                               "https://www.googleapis.com/auth/cloud-platform"])
        ee.Initialize(creds, project=project)
    else:
        ee.Initialize(project=project)


def stack():
    imgs = [ee.Image(asset).select([band], [name]) for name, asset, band, _ in LAYERS]
    return ee.Image.cat(imgs)


def osd_id(lat, lon):
    return f"{lat:.5f},{lon:.5f}"


def points():
    """จุดที่มีพิกัดจากทุกแหล่ง"""
    out = []
    p = os.path.join(ROOT, "data", "ldd", "points.json")
    if os.path.exists(p):
        for r in json.load(open(p, encoding="utf-8")):
            if r.get("lat") is not None and "far_from_province" not in r.get("qa_flags", []):
                out.append(("ldd", str(r["id"]), r["lat"], r["lon"]))
    osd = {}
    for f in glob.glob(os.path.join(ROOT, "data", "osd", "sites_*.json")):
        for r in json.load(open(f, encoding="utf-8")):
            if r.get("lat") is not None and "outside_thailand" not in r.get("qa_flags", []):
                osd[osd_id(r["lat"], r["lon"])] = (r["lat"], r["lon"])
    out += [("osd", k, lat, lon) for k, (lat, lon) in osd.items()]
    p = os.path.join(ROOT, "data", "wosis", "profiles.json")
    if os.path.exists(p):
        for r in json.load(open(p, encoding="utf-8")):
            if r.get("lat") is not None and not {"outside_thailand", "duplicate"} & set(r.get("qa_flags", [])):
                out.append(("wosis", str(r["id"]), r["lat"], r["lon"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-points", type=int, default=int(os.environ.get("GEE_MAX_POINTS", 50000)))
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    done = {}
    if os.path.exists(OUT_CSV):
        with open(OUT_CSV, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row["source"] == "osd" and "," not in row["id"]:
                    row["id"] = osd_id(float(row["lat"]), float(row["lon"]))   # แถวเก่าที่ใช้ id ของ site
                done[(row["source"], row["id"])] = row

    # จุดเดียวกันพิกัดเปลี่ยน (เช่น แก้โซน UTM) หรือมีชั้นข้อมูลใหม่ ต้องอ่านค่าใหม่
    todo = [p for p in points()
            if (p[0], p[1]) not in done
            or abs(float(done[(p[0], p[1])]["lat"]) - p[2]) > 1e-5 or abs(float(done[(p[0], p[1])]["lon"]) - p[3]) > 1e-5
            # ชั้นที่เพิ่มใหม่ (คอลัมน์ยังไม่มีในไฟล์) — ค่าว่างคืออ่านแล้วแต่แผนที่ไม่มีค่า (เมือง น้ำ) ไม่ต้องอ่านซ้ำ
            or any(c not in done[(p[0], p[1])] for c, *_ in LAYERS)]
    todo = todo[: args.max_points]
    print(f"Points to sample: {len(todo)} (already done: {len(done)})")
    if not todo:
        return

    init()
    img = stack()
    scale = {name: mult for name, _, _, mult in LAYERS}
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        fc = ee.FeatureCollection([
            ee.Feature(ee.Geometry.Point([lon, lat]), {"source": s, "id": pid, "lat": round(lat, 6), "lon": round(lon, 6)})
            for s, pid, lat, lon in chunk])
        res = img.reduceRegions(collection=fc, reducer=ee.Reducer.first(), scale=250).getInfo()
        for feat in res["features"]:
            pr = feat["properties"]
            row = {"source": pr["source"], "id": str(pr["id"]), "lat": pr["lat"], "lon": pr["lon"]}
            for name, mult in scale.items():
                v = pr.get(name)
                row[name] = round(v * mult, 3) if isinstance(v, (int, float)) else ""
            done[(row["source"], row["id"])] = row
        print(f"  {min(i + BATCH, len(todo))}/{len(todo)}")

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(sorted(done.values(), key=lambda r: (r["source"], r["id"])))
    print(f"Wrote {len(done)} rows to {OUT_CSV}")


if __name__ == "__main__":
    sys.exit(main())
