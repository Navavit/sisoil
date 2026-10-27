#!/usr/bin/env python3
"""ส่งออกแผนที่ดิน (raster) จาก Google Earth Engine เป็นภาพ PNG ทั้งประเทศ สำหรับวางทับแผนที่บนเว็บ

แหล่งที่ไม่มีบริการแผนที่ให้เรียกตรง (OpenLandMap, FAO GSOCmap) ใช้ไฟล์ภาพนี้
ส่วน SoilGrids เว็บเรียก WMS ของ ISRIC โดยตรง (ความละเอียดเต็ม)

ภาพเป็น EPSG:3857 (ตรงกับแผนที่เว็บ) ความละเอียดราว 1 km ตัดตามขอบเขตประเทศไทย
raster คงที่ จึงรันครั้งเดียว (หรือเมื่อเพิ่มชั้นใหม่) — ยืนยันตัวตนเหมือน sample_gee.py

ผลลัพธ์: data/ref/rasters/<id>.png และ rasters.json (ขอบเขต ช่วงค่า สี หน่วย แหล่ง)
"""
import json
import os
import urllib.request

import ee

from sample_gee import init

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "ref", "rasters")
WEST, SOUTH, EAST, NORTH = 97.3, 5.6, 105.7, 20.5
WIDTH = 1800  # px ด้านยาว (เหนือ-ใต้) ≈ 1 km ต่อ px
PH_PALETTE = ["b30000", "d7301f", "ef6548", "fc8d59", "fdbb84", "9ccc65", "6baed6", "3182bd", "08519c"]

# (id, asset, band, ตัวคูณ, min, max, palette, หน่วย, ชื่อ th, ชื่อ en, แหล่ง, สัญญาอนุญาต)
LAYERS = [
    ("olm_ph", "OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02", "b0", 0.1, 4.0, 8.5, PH_PALETTE, "pH",
     "pH ดินผิว (OpenLandMap 250 m)", "Topsoil pH (OpenLandMap 250 m)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    ("olm_oc", "OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02", "b0", 5, 0, 40,
     ["fff7bc", "fec44f", "d95f0e", "8c510a", "3d2203"], "g/kg",
     "อินทรีย์คาร์บอนในดินผิว (OpenLandMap)", "Topsoil organic carbon (OpenLandMap)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    ("olm_clay", "OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02", "b0", 1, 0, 60,
     ["ffffd4", "fed98e", "fe9929", "cc4c02", "662506"], "%",
     "ดินเหนียวในดินผิว (OpenLandMap)", "Topsoil clay (OpenLandMap)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    ("gsoc", "projects/sat-io/open-datasets/FAO/GSOCMAP1-5-0", "b1", 1, 0, 120,
     ["f7fcb9", "addd8e", "41ab5d", "006837", "00331a"], "t/ha",
     "คาร์บอนสะสมในดิน 0–30 cm (FAO GSOCmap 1 km)", "Soil organic carbon stock 0–30 cm (FAO GSOCmap 1 km)", "FAO Global Soil Partnership", "CC BY"),
]


def main():
    init()
    os.makedirs(OUT, exist_ok=True)
    thailand = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017").filter(ee.Filter.eq("country_na", "Thailand"))
    region = ee.Geometry.Rectangle([WEST, SOUTH, EAST, NORTH], proj="EPSG:4326", geodesic=False)
    meta = []
    for lid, asset, band, mult, vmin, vmax, palette, unit, th, en, source, lic in LAYERS:
        img = ee.Image(asset).select(band).multiply(mult).clipToCollection(thailand)
        url = img.getThumbURL({"region": region, "dimensions": WIDTH, "crs": "EPSG:3857", "format": "png",
                               "min": vmin, "max": vmax, "palette": palette})
        with urllib.request.urlopen(url, timeout=600) as r, open(os.path.join(OUT, f"{lid}.png"), "wb") as f:
            f.write(r.read())
        meta.append({"id": lid, "file": f"{lid}.png", "bounds": [[SOUTH, WEST], [NORTH, EAST]], "min": vmin, "max": vmax,
                     "palette": ["#" + c for c in palette], "unit": unit, "th": th, "en": en, "source": source, "license": lic,
                     "asset": asset})
        print(lid, os.path.getsize(os.path.join(OUT, f"{lid}.png")))
    with open(os.path.join(OUT, "rasters.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
