#!/usr/bin/env python3
"""สร้างขอบเขตจังหวัด/อำเภอ/ตำบลแบบย่อ (ใช้บนเว็บและตรวจพิกัด) จาก COD-AB ประเทศไทย

แหล่ง: OCHA / กรมแผนที่ทหาร (RTSD) — https://data.humdata.org/dataset/cod-ab-tha (CC BY-IGO)
ขอบเขตไม่ค่อยเปลี่ยน จึงรันเมื่อแหล่งออกฉบับใหม่เท่านั้น (ต้องใช้ geopandas ซึ่งไม่ใช่ stdlib)

ผลลัพธ์ (data/ref/boundaries/):
  province.geojson   77 จังหวัด  (simplify 0.001° ≈ 100 m)
  <รหัสจังหวัด>.json  อำเภอและตำบลของจังหวัดนั้น (simplify 0.0005° ≈ 50 m)
  meta.json
properties: code (เช่น 40, 4001, 400101), th, en
"""
import json
import os
import sys

import geopandas as gpd
from shapely.geometry import mapping

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "ref", "boundaries")
SOURCE_URL = "https://data.humdata.org/dataset/cod-ab-tha"


def rounded(geom, nd=4):
    def r(c):
        return [r(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], nd), round(c[1], nd)]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


def features(df, level, tol):
    df = df.copy()
    df["geometry"] = df.geometry.simplify(tol, preserve_topology=True)
    return [{"type": "Feature", "properties": {"code": r[f"adm{level}_pcode"][2:], "th": r[f"adm{level}_name1"], "en": r[f"adm{level}_name"]},
             "geometry": rounded(r.geometry)} for _, r in df.iterrows() if r.geometry is not None and not r.geometry.is_empty]


def write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main(gdb):
    os.makedirs(OUT, exist_ok=True)
    adm = {lv: gpd.read_file(gdb, layer=f"tha_admin{lv}") for lv in (1, 2, 3)}
    provinces = features(adm[1], 1, 0.001)
    write(os.path.join(OUT, "province.geojson"), {"type": "FeatureCollection", "features": provinces})
    for p in provinces:
        pc = "TH" + p["properties"]["code"]
        amphoe = features(adm[2][adm[2].adm1_pcode == pc], 2, 0.0005)
        tambon = features(adm[3][adm[3].adm1_pcode == pc], 3, 0.0005)
        for f in amphoe:
            f["properties"]["level"] = 2
        for f in tambon:
            f["properties"]["level"] = 3
        write(os.path.join(OUT, f"{p['properties']['code']}.json"), {"type": "FeatureCollection", "features": amphoe + tambon})
    write(os.path.join(OUT, "meta.json"), {
        "source": "OCHA / Royal Thai Survey Department – Thailand Subnational Administrative Boundaries (COD-AB)",
        "source_url": SOURCE_URL, "license": "CC BY-IGO",
        "valid_on": str(adm[1].valid_on.max())[:10], "version": str(adm[1].version.iloc[0]),
        "counts": {"province": len(adm[1]), "amphoe": len(adm[2]), "tambon": len(adm[3])},
        "simplify_deg": {"province": 0.001, "amphoe_tambon": 0.0005}, "coord_decimals": 4,
    })
    print({k: len(v) for k, v in adm.items()})


if __name__ == "__main__":
    main(sys.argv[1])
