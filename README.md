# ฐานข้อมูลจุดสำรวจดินไทย (Thai Soil Survey Database)

ระบบรวบรวมข้อมูลดินจากแหล่งข้อมูลเปิดของประเทศไทย ตรวจหาข้อมูลใหม่อัตโนมัติทุกเดือน ทำความสะอาดข้อมูลอย่างโปร่งใส และแสดงผลเป็นแผนที่บนเว็บไซต์

| แหล่ง | ข้อมูล | สัญญาอนุญาต |
|---|---|---|
| กรมพัฒนาที่ดิน – Soil Survey Public | จุดสำรวจดิน (ระดับ pH/OM/P/K, เนื้อดิน) | ไม่ระบุ © LDD |
| กรมพัฒนาที่ดิน – การตรวจวิเคราะห์ดิน (osd01) | ผลวิเคราะห์ดินเป็นตัวเลข (pH, EC, OM, P, K) | CC BY |
| ISRIC – WoSIS | soil profile แยกชั้นความลึก ผลแล็บ (pH, OC, N, เนื้อดิน, CEC, BD) | CC BY / CC0 / PD ต่อชุดข้อมูล |
| Google Earth Engine – OpenLandMap, SoilGrids | ค่าคุณสมบัติดินที่จุดสำรวจ (ใช้เทียบ) | CC BY-SA / CC BY |

รายชื่อแหล่งทั้งหมด (รวมที่กำลังจะเพิ่ม) อยู่ที่ [docs/sources.md](docs/sources.md) และหน้า **แหล่งข้อมูล** บนเว็บไซต์

- 🌐 **เว็บไซต์**: <https://navavit.github.io/thai-soil-db/> มีทั้งภาษาไทยและอังกฤษ (`?lang=en`) ประกอบด้วยแผนที่ ตัวกรอง ตาราง และดาวน์โหลด
- 📥 **ดาวน์โหลด**: [`points.csv`](data/ldd/points.csv) · [`points.geojson`](data/ldd/points.geojson) · [`points.json`](data/ldd/points.json)
- 🔄 **อัปเดต**: GitHub Actions รันวันที่ 1 ของทุกเดือน และเปิด Issue แจ้งเตือนเมื่อพบข้อมูลใหม่

## การไหลของข้อมูล

```mermaid
flowchart LR
    LDD[("LDD<br/>SoilSurveyAPI")] -->|"1 ตรวจจำนวนจุด<br/>รายจังหวัด"| CHK{เปลี่ยน?}
    CHK -->|ไม่| SKIP[ข้าม]
    CHK -->|ใช่| LIST["2 ดึงรายการจุด"]
    LIST --> DET["3 ดึงรายละเอียด<br/>เฉพาะจุดใหม่"]
    DET --> UTM["4 แปลง UTM → WGS84"]
    UTM --> DIFF["5 เทียบรอบก่อน"]
    SKIP --> DIFF
    DIFF --> DATA[("data/")]
    DIFF -->|มีของใหม่| ISSUE[GitHub Issue]
    DATA --> WEB[GitHub Pages]
```

- แผนภาพฉบับเต็มและ **ER diagram**: [docs/architecture.md](docs/architecture.md)
- **วิธีทำความสะอาดข้อมูล** (ทุกขั้นตอน พร้อมตัวเลขจากข้อมูลจริง): [docs/data-cleaning.md](docs/data-cleaning.md)

## โครงสร้างโฟลเดอร์

```
.
├── README.md
├── .github/workflows/
│   ├── update-data.yml     # ตรวจข้อมูลใหม่รายเดือน → commit → Issue → deploy
│   └── pages.yml           # deploy เว็บไซต์ขึ้น GitHub Pages
├── scripts/
│   ├── fetch_ldd.py        # จุดสำรวจดิน LDD (Python stdlib ล้วน)
│   ├── fetch_osd.py        # ผลวิเคราะห์ดิน LDD (Python stdlib ล้วน)
│   ├── fetch_wosis.py      # soil profile จาก ISRIC WoSIS (Python stdlib ล้วน)
│   └── sample_gee.py       # สุ่มค่าจาก Google Earth Engine (ต้องใช้ earthengine-api)
├── data/                   # ข้อมูลที่ระบบสร้าง (อย่าแก้ด้วยมือ)
│   ├── meta.json           # สรุปการอัปเดตล่าสุด
│   ├── changelog.json      # ประวัติทุกรอบ
│   ├── changes/            # รายการเพิ่ม/ลบ/แก้ไขแต่ละรอบ
│   ├── ldd/
│   │   ├── points.json     # ข้อมูลหลัก
│   │   ├── points.geojson
│   │   ├── points.csv
│   │   └── state.json      # จำนวนจุดรายจังหวัด (ใช้ตรวจก่อนดึง)
│   ├── osd/                # ผลวิเคราะห์ดิน: sites_<ปี>.json, sites.csv, measurements_<ปี>.csv.gz, state.json
│   ├── wosis/              # profiles.json, profiles.csv, layers.csv
│   └── gee/                # covariates.csv (ค่าจาก GEE ที่แต่ละจุด)
├── site/                   # เว็บไซต์สองภาษา (HTML/CSS/JS + Leaflet, i18n.js)
├── docs/
│   ├── architecture.md     # flowchart + ER diagram
│   ├── data-cleaning.md    # วิธีทำความสะอาดข้อมูล
│   ├── gee-github-actions.md # ตั้งค่า GEE บน Actions แบบไม่ใช้ไฟล์ key
│   └── sources.md          # รายชื่อแหล่งข้อมูลดินแบบเปิด
└── notebooks/              # Jupyter สำหรับวิเคราะห์ (เก็บในเครื่อง ไม่ขึ้น GitHub)
```

## ใช้งานในเครื่อง

```bash
# ดึงข้อมูล (ตรวจจำนวนก่อน ดึงเฉพาะส่วนที่เปลี่ยน)
python3 scripts/fetch_ldd.py

# เฉพาะบางจังหวัด / จำกัดจำนวนรายละเอียด / บังคับดึงใหม่ทั้งหมด
python3 scripts/fetch_ldd.py --provinces 40,30 --max-details 500
python3 scripts/fetch_ldd.py --full

# เปิดเว็บไซต์ในเครื่อง
mkdir -p _site && cp -r site/* _site/ && cp -r data _site/ && python3 -m http.server -d _site 8000

# ผลวิเคราะห์ดิน (ย้อนหลังทีละไม่เกิน N เดือนต่อรอบ)
python3 scripts/fetch_osd.py --max-months 24

# soil profile จาก WoSIS
python3 scripts/fetch_wosis.py

# Google Earth Engine — ใส่ EE_PROJECT และ EE_KEY_FILE ใน .env (คัดลอกจาก .env.example)
# หรือไม่ใช้ key: earthengine authenticate แล้วใส่แค่ EE_PROJECT
pip install earthengine-api && python3 scripts/sample_gee.py

# วิเคราะห์ด้วย Jupyter
pip install -r notebooks/requirements.txt && jupyter lab notebooks/
```

## สั่งอัปเดตเอง

ไปที่แท็บ **Actions → ตรวจข้อมูลใหม่ (LDD) → Run workflow** แล้วตั้งค่าได้ดังนี้
- `max_details` — จำนวนจุดที่ดึงรายละเอียดต่อรอบ (ค่าเริ่มต้น 2000 เพื่อไม่ให้เซิร์ฟเวอร์ LDD รับภาระหนัก)
- `full` — ดึงรายการทุกจังหวัดใหม่ เพื่อจับการแก้ไขข้อมูล
- `provinces` — เฉพาะรหัสจังหวัดที่ระบุ

## ตั้งค่า Google Earth Engine บน GitHub Actions

แนะนำ **Workload Identity Federation** (ไม่มีไฟล์ key เก็บไว้ที่ใด) ทำตาม [docs/gee-github-actions.md](docs/gee-github-actions.md)
แล้วใส่ Variables `GCP_WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `EE_PROJECT`

ทางเลือกเดิม: secret `EE_SERVICE_ACCOUNT_KEY` (JSON ของ service account) + variable `EE_PROJECT`
ถ้าไม่ตั้งค่าใดเลย ขั้นตอน GEE จะถูกข้าม (รัน `scripts/sample_gee.py` ในเครื่องแล้ว push แทนได้)

## ข้อควรทราบ

- ข้อมูลเป็นสิทธิ์ของ **กรมพัฒนาที่ดิน** repo นี้เป็นสำเนาเพื่อการศึกษาและวิเคราะห์ ใช้เฉพาะ API สาธารณะแบบอ่านอย่างเดียว และหน่วงเวลาระหว่างคำขอ
- แต่ละจุดมีวันที่ 4 แบบ: `date` (วันสำรวจภาคสนาม), `first_seen` (วันที่เก็บเข้าระบบ), `last_seen` (พบล่าสุดที่ต้นทาง), `detail_fetched_at` (วันที่ดึงรายละเอียด)
- ค่า pH / OM / P / K จากแหล่งนี้เป็น **ระดับ** (เช่น "กรดจัด", "ต่ำ") ไม่ใช่ค่าตัวเลข
- จุดที่ไม่มี lat/lon แต่มีพิกัด UTM ถูกแปลงเป็น WGS84 (`coord_source = utm`) โดยสมมติ datum WGS84 บางจุดระบุโซนผิด ระบบเลือกโซนที่ใกล้จังหวัดของจุดนั้นที่สุด (`utm_zone_fixed`) ถ้าข้อมูลต้นทางใช้ Indian 1975 พิกัดอาจคลาดเคลื่อนประมาณ 300–400 ม.
