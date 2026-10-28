#!/usr/bin/env python3
"""ตรวจว่าแผนที่การใช้ที่ดินของ LDD จังหวัดใดมีฉบับใหม่ (ปีสำรวจใหม่หรือไฟล์ถูกแก้)

LDD สำรวจการใช้ที่ดินหมุนเวียน ~12–16 จังหวัดต่อปี (รอบละ ~6 ปี) และหน้าดาวน์โหลดมีเฉพาะฉบับล่าสุด
สคริปต์นี้อ่านเฉพาะ metadata: วันที่อัปโหลด (HEAD) และชื่อไฟล์ในท้าย ZIP (HTTP Range 64 KB) ซึ่งบอกปีสำรวจ
เช่น LU_CMI_2567.shp — ไม่ดาวน์โหลดหรือเผยแพร่ตัวข้อมูล (CC BY-NC-ND)

ผล: data/ref/landuse_state.json (จังหวัด, ปีสำรวจ, วันที่อัปโหลด) และ GITHUB_OUTPUT สำหรับแจ้งเตือนผ่าน Issue
"""
import datetime as dt
import json
import os
import re
import socket
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "data", "ref", "landuse_state.json")
BASE = "https://tswc.ldd.go.th/DownloadGIS/"
PAGE = BASE + "Index_Lu.html"
UA = {"User-Agent": "thai-soil-db/1.0 (open-data mirror)"}

# tswc.ldd.go.th ประกาศ IPv6 แต่บางเครือข่ายต่อไม่ได้
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *a, **k: sorted(_getaddrinfo(*a, **k), key=lambda r: r[0] != socket.AF_INET)


def request(url, method="GET", headers=None, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, method=method, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=120) as r:
                return dict(r.headers), r.read() if method == "GET" else b""
        except OSError as e:
            print(f"  ! {url}: {e}", file=sys.stderr)
            time.sleep(5 * 2 ** attempt)
    return None, None


def list_provinces():
    """[(code, ชื่อจังหวัด, url)] จากหน้าดาวน์โหลด (หน้าเข้ารหัส TIS-620)"""
    _, body = request(PAGE)
    if body is None:
        raise RuntimeError("อ่านหน้าดาวน์โหลดไม่ได้")
    page = body.decode("cp874", errors="replace")
    out = []
    for href, name in re.findall(r'href="([^"]+\.zip)"[^>]*>([^<]*)<', page):
        m = re.search(r"Landuse_([A-Za-z]+)\.zip$", href)
        if m:
            out.append((m.group(1).lower(), name.strip(), BASE + href))
    return out


def probe(url):
    """วันที่อัปโหลด ขนาด และปีสำรวจ (พ.ศ.) จากชื่อ shapefile ในท้าย ZIP"""
    head, _ = request(url, "HEAD")
    if head is None:
        return None
    _, tail = request(url, headers={"Range": "bytes=-65536"})
    years = sorted({int(y) for y in re.findall(rb"LU_[A-Za-z]{2,4}_(\d{4})\.shp", tail or b"")})
    return {"last_modified": head.get("Last-Modified"), "size": int(head.get("Content-Length") or 0), "survey_years_be": years}


def main():
    today = dt.date.today().isoformat()
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)
    changed = []
    for code, name, url in list_provinces():
        info = probe(url)
        time.sleep(0.5)
        if info is None:
            print(f"{name}: ตรวจไม่ได้ (ข้าม)")
            continue
        old = state.get(code)
        is_changed = bool(old) and (old["survey_years_be"] != info["survey_years_be"] or old["last_modified"] != info["last_modified"])
        if is_changed:
            kind = "ปีสำรวจใหม่" if old["survey_years_be"] != info["survey_years_be"] else "ไฟล์ถูกแก้ไข"
            changed.append(f"- **{name}**: {kind} {old['survey_years_be']} → {info['survey_years_be']} (อัปโหลด {info['last_modified']})")
        state[code] = {"name": name, "url": url, **info, "checked_at": today,
                       "changed_at": today if (is_changed or not old) else old.get("changed_at")}
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(state.items())), f, ensure_ascii=False, indent=1)
        f.write("\n")
    years = {}
    for v in state.values():
        for y in v["survey_years_be"]:
            years[y] = years.get(y, 0) + 1
    print(f"{len(state)} จังหวัด · ปีสำรวจ: {dict(sorted(years.items()))} · เปลี่ยน {len(changed)}")
    print("\n".join(changed))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"lu_changed={len(changed)}\n")
            f.write("lu_summary<<EOF\n" + "\n".join(changed) + "\nEOF\n")


if __name__ == "__main__":
    main()
