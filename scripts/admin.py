"""หาจังหวัด/อำเภอ/ตำบลจากพิกัด ด้วยขอบเขตใน data/ref/boundaries (Python stdlib ล้วน)

ใช้ตรวจคุณภาพพิกัดของทุกแหล่ง:
  locate(lat, lon)            -> {"province": "40", "amphoe": "4001", "tambon": "400101"} หรือ None ถ้าไม่อยู่บนบก
  dist_km(code, lat, lon)     -> ระยะจากพิกัดถึงขอบเขตของพื้นที่ code (0 ถ้าอยู่ข้างใน)
  province_code(name)         -> รหัสจังหวัดจากชื่อไทยหรืออังกฤษ
ขอบเขตถูกย่อรูปไว้ ~50–100 m จึงควรเผื่อระยะ (TOL_KM) ก่อนตัดสินว่าอยู่นอกพื้นที่
"""
import difflib
import glob
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "data", "ref", "boundaries")
TOL_KM = 1.0
# ข้อมูลที่ไม่มั่นใจตำแหน่ง: เก็บไว้ในไฟล์ (หลังบ้าน) แต่ไม่แสดงบนเว็บ — ต้องตรงกับ HIDE_ON_MAP ใน site/app.js
HIDE_ON_MAP = {"no_coords", "outside_thailand", "off_land", "far_from_province", "no_location", "duplicate",
               "shared_coords", "multi_sample", "amphoe_mismatch", "date_future"}


def confident(flags):
    return not HIDE_ON_MAP.intersection(flags or ())


def coord_key(lat, lon):
    """พิกัดปัด 5 ตำแหน่ง (~1 m) ใช้ตัดสินว่าพิกัดซ้ำ"""
    return (round(lat, 5), round(lon, 5))


def _source_coords(source):
    """พิกัดทุกแถวของแหล่งข้อมูล (จากไฟล์ที่บันทึกไว้ล่าสุด)"""
    data = os.path.join(ROOT, "data")
    if source == "ldd":
        paths, skip = [os.path.join(data, "ldd", "points.json")], None
    elif source == "osd":
        paths, skip = sorted(glob.glob(os.path.join(data, "osd", "sites_*.json"))), None
    else:
        paths, skip = [os.path.join(data, "wosis", "profiles.json")], "duplicate_of"
    out = []
    for path in paths:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                out += [coord_key(r["lat"], r["lon"]) for r in json.load(f)
                        if r.get("lat") is not None and r.get("lon") is not None and not (skip and r.get(skip))]
    return out


def shared_coords(source, records):
    """พิกัดที่ใช้ซ้ำ: มากกว่าหนึ่งแถวในแหล่งเดียวกัน หรือตรงกับพิกัดของแหล่งอื่น (ldd, osd, wosis)

    records = แถวของแหล่งนี้ที่ยังอยู่ในหน่วยความจำ (ค่าล่าสุด) ส่วนแหล่งอื่นอ่านจากไฟล์
    """
    own = {}
    for r in records:
        if r.get("lat") is not None and r.get("lon") is not None:
            k = coord_key(r["lat"], r["lon"])
            own[k] = own.get(k, 0) + 1
    others = {k for s in ("ldd", "osd", "wosis") if s != source for k in _source_coords(s)}
    return {k for k, n in own.items() if n > 1 or k in others}


BAND = 0.02   # ความสูงของแถบที่ใช้จัดกลุ่มเส้นขอบ (องศา)


class Area:
    def __init__(self, feature):
        p = feature["properties"]
        self.code, self.th, self.en = p["code"], p["th"], p["en"]
        g = feature["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        self.edges = [(a[0], a[1], b[0], b[1]) for poly in polys for ring in poly for a, b in zip(ring, ring[1:])]
        xs = [c for e in self.edges for c in (e[0], e[2])]
        ys = [c for e in self.edges for c in (e[1], e[3])]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.bands = {}
        for e in self.edges:
            for b in range(math.floor(min(e[1], e[3]) / BAND), math.floor(max(e[1], e[3]) / BAND) + 1):
                self.bands.setdefault(b, []).append(e)

    def contains(self, lat, lon):
        x0, y0, x1, y1 = self.bbox
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            return False
        inside = False
        for ax, ay, bx, by in self.bands.get(math.floor(lat / BAND), ()):
            if (ay > lat) != (by > lat) and lon < ax + (lat - ay) * (bx - ax) / (by - ay):
                inside = not inside
        return inside

    def dist_km(self, lat, lon):
        if self.contains(lat, lon):
            return 0.0
        kx = 111.32 * math.cos(math.radians(lat))
        best = math.inf
        for ax, ay, bx, by in self.edges:
            px, py = (lon - ax) * kx, (lat - ay) * 110.57
            dx, dy = (bx - ax) * kx, (by - ay) * 110.57
            t = max(0.0, min(1.0, (px * dx + py * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
            best = min(best, math.hypot(px - t * dx, py - t * dy))
        return best


_provinces = None
_children = {}


def _load(name):
    with open(os.path.join(DIR, name), encoding="utf-8") as f:
        return json.load(f)["features"]


def available():
    return os.path.exists(os.path.join(DIR, "province.geojson"))


def provinces():
    global _provinces
    if _provinces is None:
        _provinces = {a.code: a for a in map(Area, _load("province.geojson"))}
    return _provinces


def children(pcode):
    if pcode not in _children:
        fs = _load(f"{pcode}.json")
        _children[pcode] = ({f["properties"]["code"]: Area(f) for f in fs if f["properties"]["level"] == 2},
                            {f["properties"]["code"]: Area(f) for f in fs if f["properties"]["level"] == 3})
    return _children[pcode]


def area(code):
    if len(code) == 2:
        return provinces().get(code)
    amphoe, tambon = children(code[:2])
    return (amphoe if len(code) == 4 else tambon).get(code)


def locate(lat, lon):
    prov = next((a for a in provinces().values() if a.contains(lat, lon)), None)
    if prov is None:
        return None
    amphoe, tambon = children(prov.code)
    amp = next((a for a in amphoe.values() if a.contains(lat, lon)), None)
    tb = next((a for c, a in tambon.items() if (amp is None or c.startswith(amp.code)) and a.contains(lat, lon)), None)
    return {"province": prov.code, "amphoe": amp.code if amp else None, "tambon": tb.code if tb else None}


def nearest_province(lat, lon):
    return min(((a.dist_km(lat, lon), a.code) for a in provinces().values()))


def dist_km(code, lat, lon):
    a = area(code)
    return a.dist_km(lat, lon) if a else None


def norm(name):
    """ชื่อสำหรับเทียบ: ตัดคำนำหน้า เว้นวรรค ขีด และตัวพิมพ์"""
    s = re.sub(r"^(จังหวัด|อำเภอ|ตำบล|เขต|แขวง|กิ่งอำเภอ|จ\.|อ\.|ต\.)\s*", "", (name or "").strip())
    s = re.sub(r"\b(province|district|amphoe|tambon|subdistrict|mueang|muang)\b", "", s, flags=re.I)
    return re.sub(r"[\s\-'.()]", "", s).lower()


def province_code(name):
    n = norm(name)
    for a in provinces().values():
        if n in (norm(a.th), norm(a.en)):
            return a.code
    return None


def name_matches(code, name):
    """ชื่อ (ไทยหรืออังกฤษ) ตรงกับพื้นที่ code หรือไม่ (None = เทียบไม่ได้)"""
    a = area(code) if code else None
    if a is None or not name:
        return None
    n = norm(name)
    names = {norm(a.th), norm(a.en)}
    # อำเภอเมือง: บางแหล่งเขียน "เมืองนครศรีธรรมราช" บางแหล่งเขียน "นครศรีธรรมราช"
    return n in names or n.removeprefix("เมือง") in {x.removeprefix("เมือง") for x in names}


def _best(name, areas, cutoff=0.85):
    """พื้นที่ที่ชื่อตรงที่สุด: ตรงทุกตัว (รวม "เมืองX" = "X") ก่อน ไม่เช่นนั้นใกล้เคียง ≥ cutoff (สะกดต่างเล็กน้อย)"""
    n = norm(name)
    if not n:
        return None
    for a in areas:
        if name_matches(a.code, name):
            return a
    key = n.removeprefix("เมือง")
    scored = [(difflib.SequenceMatcher(None, key, norm(a.th).removeprefix("เมือง")).ratio(), a) for a in areas]
    score, a = max(scored, key=lambda x: x[0], default=(0, None))
    return a if score >= cutoff else None


def match_names(province, amphoe=None, tambon=None):
    """รหัส humdata จากชื่อ (จังหวัด → อำเภอ → ตำบล) คืนรหัสระดับที่ละเอียดที่สุดที่จับคู่ได้ หรือ None"""
    pc = province_code(province)
    if not pc:
        return None
    amphoes, tambons = children(pc)
    amp = _best(amphoe, amphoes.values()) if amphoe else None
    tb = _best(tambon, [a for c, a in tambons.items() if amp and c.startswith(amp.code)]) if tambon else None
    if tb is None and tambon:
        # อำเภอที่ระบุไม่มีตำบลนี้ (เช่น ตำบลถูกย้ายอำเภอ หรือกรอกอำเภอผิด): ใช้ตำบลชื่อตรงกันในจังหวัดเดียวกัน ถ้ามีแห่งเดียว
        same = [a for a in tambons.values() if name_matches(a.code, tambon)]
        tb = same[0] if len(same) == 1 else None
    return tb.code if tb else amp.code if amp else pc
