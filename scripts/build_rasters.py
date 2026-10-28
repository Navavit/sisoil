#!/usr/bin/env python3
"""ส่งออกแผนที่ดิน (raster) จาก Google Earth Engine เป็นภาพ PNG ทั้งประเทศ สำหรับวางทับแผนที่บนเว็บ

แหล่งที่ไม่มีบริการแผนที่ให้เรียกตรง (OpenLandMap, FAO GSOCmap) ใช้ไฟล์ภาพนี้
ส่วน SoilGrids เว็บเรียก WMS ของ ISRIC โดยตรง (ความละเอียดเต็ม)

ภาพเป็น EPSG:3857 (ตรงกับแผนที่เว็บ) ความละเอียดราว 1 km ตัดตามขอบเขตประเทศไทย
raster คงที่ จึงรันครั้งเดียว (หรือเมื่อเพิ่มชั้นใหม่) — ยืนยันตัวตนเหมือน sample_gee.py

ผลลัพธ์: data/ref/rasters/<id>.png และ rasters.json (ขอบเขต ช่วงชั้นที่ใช้ แหล่ง)
จัดชั้นด้วยช่วงชั้นและสีจาก site/scales.js เหมือนสีจุดบนเว็บ
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


def load_scales():
    """ช่วงชั้นและสีจาก site/scales.js (ชุดเดียวกับสีจุดบนเว็บ)"""
    with open(os.path.join(ROOT, "site", "scales.js"), encoding="utf-8") as f:
        text = f.read()
    return json.loads(text[text.index("const SCALES =") + len("const SCALES ="):].strip().rstrip(";"))


# (id, asset, band, ตัวคูณจากค่าดิบเป็นหน่วยของช่วงชั้น, ช่วงชั้นใน scales.js, ชื่อ th, ชื่อ en, แหล่ง, สัญญาอนุญาต)
LAYERS = [
    ("olm_ph", "OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02", "b0", 0.1, "ph",
     "pH ดินผิว (OpenLandMap 250 m)", "Topsoil pH (OpenLandMap 250 m)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    # ค่าดิบ = OC หน่วย 5 g/kg → OM % = OC (g/kg) × 0.1724
    ("olm_om", "OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02", "b0", 5 * 0.1724, "om",
     "อินทรียวัตถุ (OM) ดินผิว จาก OC (OpenLandMap)", "Topsoil organic matter from OC (OpenLandMap)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    ("olm_clay", "OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02", "b0", 1, "clay",
     "ดินเหนียวในดินผิว (OpenLandMap)", "Topsoil clay (OpenLandMap)", "OpenLandMap / OpenGeoHub", "CC BY-SA 4.0"),
    ("gsoc", "projects/sat-io/open-datasets/FAO/GSOCMAP1-5-0", "b1", 1, "gsoc",
     "คาร์บอนสะสมในดิน 0–30 cm (FAO GSOCmap 1 km)", "Soil organic carbon stock 0–30 cm (FAO GSOCmap 1 km)", "FAO Global Soil Partnership", "CC BY"),
]


def main():
    init()
    os.makedirs(OUT, exist_ok=True)
    scales = load_scales()
    thailand = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017").filter(ee.Filter.eq("country_na", "Thailand"))
    region = ee.Geometry.Rectangle([WEST, SOUTH, EAST, NORTH], proj="EPSG:4326", geodesic=False)
    for old in os.listdir(OUT):
        if old.endswith(".png"):
            os.remove(os.path.join(OUT, old))
    meta = []
    for lid, asset, band, mult, key, th, en, source, lic in LAYERS:
        sc = scales[key]
        img = ee.Image(asset).select(band).multiply(mult)
        # จัดชั้น: จำนวนขอบที่ค่ามากกว่าหรือเท่ากับ = ลำดับชั้น (ตรงกับ classIndex ใน site/app.js)
        cls = ee.Image.constant(0)
        for b in sc["bins"]:
            cls = cls.add(img.gte(b))
        cls = cls.updateMask(img.mask()).clipToCollection(thailand)
        url = cls.getThumbURL({"region": region, "dimensions": WIDTH, "crs": "EPSG:3857", "format": "png",
                               "min": 0, "max": len(sc["colors"]) - 1, "palette": [c.lstrip("#") for c in sc["colors"]]})
        with urllib.request.urlopen(url, timeout=600) as r, open(os.path.join(OUT, f"{lid}.png"), "wb") as f:
            f.write(r.read())
        meta.append({"id": lid, "file": f"{lid}.png", "bounds": [[SOUTH, WEST], [NORTH, EAST]], "scale": key,
                     "th": th, "en": en, "source": source, "license": lic, "asset": asset})
        print(lid, os.path.getsize(os.path.join(OUT, f"{lid}.png")))
    with open(os.path.join(OUT, "rasters.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
