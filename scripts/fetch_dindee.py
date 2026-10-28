#!/usr/bin/env python3
"""ดึงข้อมูลบัตรดินดี (ผลวิเคราะห์ดินของเกษตรกรรายตัวอย่าง ระดับตำบล) จากกรมพัฒนาที่ดิน

แหล่ง: https://lddcatalog.ldd.go.th/dataset/osd02  (CC BY, ลงรายการใน data.go.th ด้วย)
ไฟล์:  CSV ไฟล์เดียว (~3.5 MB) ไม่มีพิกัด มีเพียง จังหวัด/อำเภอ/ตำบล

ค่า pH/N/P/K เป็นระดับพร้อมช่วงค่าในวงเล็บ เช่น "กรดจัด (pH 5.1 - 5.5)" แยกเป็น ระดับ + ช่วงค่า
หมายเหตุ: ช่วงของ N (เช่น 1.51 - 2.50%) ตรงกับเกณฑ์อินทรียวัตถุ (OM) ของ LDD มากกว่าไนโตรเจน
          เก็บชื่อคอลัมน์ตามต้นทาง และระบุไว้ใน meta.json

วิธีไม่ดึงซ้ำ: HEAD ดู ETag/Last-Modified ถ้าเหมือนรอบก่อน ข้ามการดาวน์โหลด

โครงสร้างข้อมูล (data/dindee/):
  samples.csv      หนึ่งแถวต่อตัวอย่าง
  by_tambon.csv    จำนวนตัวอย่างและระดับ pH ที่พบมากที่สุดต่อตำบล
  state.json, meta.json, changelog.json
"""
import collections
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import urllib.request

URL = ("https://lddcatalog.ldd.go.th/dataset/752773dd-c173-4c5a-ab15-90e86c54af00/resource/"
       "9f552569-f025-4e97-abe1-ec44fa3ae31f/download/iddindee.csv")
SOURCE_URL = "https://lddcatalog.ldd.go.th/dataset/osd02"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "dindee")
UA = {"User-Agent": "SISoil/1.0 (open-data mirror; https://navavit.github.io/sisoil/)"}
PARAMS = ["pH", "N", "P", "K"]
NOT_ANALYSED = "ไม่ได้วิเคราะห์"
QA_FLAGS = {
    "date_invalid": "แปลงวันที่ไม่ได้",
    "date_future": "วันที่อยู่ในอนาคต",
    "not_analysed": "มีบางค่าไม่ได้วิเคราะห์",
    "unparsed_class": "มีค่าที่แยกระดับ/ช่วงไม่ได้ (เก็บข้อความเดิม)",
}
COLUMNS = ["id", "date", "province", "amphoe", "tambon",
           *[f"{p.lower()}_{x}" for p in PARAMS for x in ("class", "range")], "first_seen", "qa_flags"]


def request(method, retries=5):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(URL, headers=UA, method=method)
            with urllib.request.urlopen(req, timeout=180) as r:
                return dict(r.headers), (r.read() if method == "GET" else b"")
        except OSError as e:
            wait = 5 * 2 ** attempt
            print(f"  ! {method} failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{method} {URL} failed after {retries} attempts")


def split_class(v):
    """'กรดจัด (pH 5.1 - 5.5)' -> ('กรดจัด', 'pH 5.1 - 5.5')"""
    v = (v or "").strip()
    if not v or v == NOT_ANALYSED:
        return None, None, v == NOT_ANALYSED
    m = re.match(r"^(.*?)\s*\((.*)\)\s*$", v)
    return (m.group(1).strip(), m.group(2).strip(), False) if m else (v, None, False)


def parse_date(s):
    try:
        return dt.datetime.strptime((s or "").strip(), "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.date().isoformat()
    state = load_json(os.path.join(OUT, "state.json"), {})

    headers, _ = request("HEAD")
    version = {"etag": headers.get("ETag"), "last_modified": headers.get("Last-Modified"),
               "size": headers.get("Content-Length")}
    if state.get("version") == version and os.path.exists(os.path.join(OUT, "samples.csv")):
        print(f"ไม่มีการเปลี่ยนแปลง (Last-Modified {version['last_modified']})")
        state["checked_at"] = today
        write_json(os.path.join(OUT, "state.json"), state)
        return

    _, body = request("GET")
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
    print(f"ดาวน์โหลด {len(rows)} แถว")

    old = {}
    if os.path.exists(os.path.join(OUT, "samples.csv")):
        with open(os.path.join(OUT, "samples.csv"), encoding="utf-8-sig") as f:
            old = {r["id"]: r for r in csv.DictReader(f)}

    samples = {}
    for r in rows:
        sid = (r.get("AnalyItem") or "").strip()
        if not sid:
            continue
        s = {"id": sid, "date": parse_date(r.get("InquiryDate")), "province": r.get("Pname") or None,
             "amphoe": r.get("Aname") or None, "tambon": r.get("Tname") or None}
        flags = set()
        for p in PARAMS:
            cls, rng, na = split_class(r.get(p))
            s[f"{p.lower()}_class"], s[f"{p.lower()}_range"] = cls, rng
            if na:
                flags.add("not_analysed")
            elif cls and not rng:
                flags.add("unparsed_class")
        if s["date"] is None:
            flags.add("date_invalid")
        elif s["date"] > today:
            flags.add("date_future")
        s["qa_flags"] = [f for f in QA_FLAGS if f in flags]
        s["first_seen"] = (old.get(sid) or {}).get("first_seen") or today
        samples[sid] = s   # id ซ้ำ: ใช้แถวหลังสุด

    added = [i for i in samples if i not in old]
    removed = [i for i in old if i not in samples]
    ordered = sorted(samples.values(), key=lambda s: (s["date"] or "", s["id"]))
    with open(os.path.join(OUT, "samples.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for s in ordered:
            w.writerow({**s, "qa_flags": ";".join(s["qa_flags"])})

    tambons = collections.defaultdict(list)
    for s in ordered:
        tambons[(s["province"], s["amphoe"], s["tambon"])].append(s)
    with open(os.path.join(OUT, "by_tambon.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["province", "amphoe", "tambon", "n_samples", "ph_class_mode", "ph_class_mode_n", "first_date", "last_date"])
        for (pv, am, tb), ss in sorted(tambons.items(), key=lambda kv: tuple(x or "" for x in kv[0])):
            mode = collections.Counter(s["ph_class"] for s in ss if s["ph_class"]).most_common(1)
            dates = sorted(s["date"] for s in ss if s["date"])
            w.writerow([pv, am, tb, len(ss), *(mode[0] if mode else (None, 0)),
                        dates[0] if dates else None, dates[-1] if dates else None])

    state = {"version": version, "checked_at": today, "downloaded_at": today}
    write_json(os.path.join(OUT, "state.json"), state)
    summary = {"date": today, "total": len(samples), "added": len(added), "removed": len(removed)}
    log = [e for e in load_json(os.path.join(OUT, "changelog.json"), []) if e["date"] != today] + [summary]
    write_json(os.path.join(OUT, "changelog.json"), log)
    years = collections.Counter((s["date"] or "")[:4] for s in ordered if s["date"])
    write_json(os.path.join(OUT, "meta.json"), {
        "source": "กรมพัฒนาที่ดิน – ข้อมูลบัตรดินดี (osd02)", "source_url": SOURCE_URL, "license": "CC BY",
        "updated_at": now.isoformat(), "source_last_modified": version["last_modified"],
        "samples": len(samples), "provinces": len({s["province"] for s in ordered}), "tambons": len(tambons),
        "years": dict(sorted(years.items())),
        "coordinates": "ไม่มี — ระดับตำบลเท่านั้น",
        "notes": ["date = วันที่ส่งข้อมูล (InquiryDate) ไม่ใช่วันเก็บตัวอย่าง",
                  "ช่วงค่าของ N ตรงกับเกณฑ์อินทรียวัตถุ (OM %) ของ LDD — ชื่อคอลัมน์คงตามต้นทาง"],
        "qa": {k: {"description": v, "samples": sum(1 for s in ordered if k in s["qa_flags"])} for k, v in QA_FLAGS.items()},
    })
    print(json.dumps(summary, ensure_ascii=False))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"dindee_added={len(added)}\ndindee_total={len(samples)}\n")


if __name__ == "__main__":
    main()
