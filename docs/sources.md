# แหล่งข้อมูลดินแบบเปิดของประเทศไทย

## ที่ใช้อยู่ในระบบ

**ข้อมูลดิน** (เรียงตามความน่าเชื่อถือ)

| แหล่ง | ประเภท | วิธีดึง |
|---|---|---|
| ISRIC WoSIS<br><https://www.isric.org/explore/wosis> | soil profile แยกชั้นความลึก + ผลแล็บ | `scripts/fetch_wosis.py` ผ่าน WFS |
| กรมพัฒนาที่ดิน – ผลวิเคราะห์ดิน (osd01) | ค่าตัวเลข pH, EC, OM, P, K | `scripts/fetch_osd.py` |
| กรมพัฒนาที่ดิน – Soil Survey Public<br><https://soilservice.ldd.go.th/soilsurveypublic/> | จุดสำรวจภาคสนาม (ระดับ pH, OM, P, K, เนื้อดิน) | `scripts/fetch_ldd.py` ผ่าน procedure สาธารณะแบบอ่านอย่างเดียว |
| กรมพัฒนาที่ดิน – บัตรดินดี (osd02) | ผลตรวจดินของเกษตรกร ระดับตำบล | `scripts/fetch_dindee.py` ดาวน์โหลดเมื่อ ETag เปลี่ยน |
| Google Earth Engine – OpenLandMap, SoilGrids, FAO GSOCmap | ค่าที่จุดข้อมูล + ภาพแผนที่ดินทั้งประเทศ | `scripts/sample_gee.py`, `scripts/build_rasters.py` |
| ISRIC SoilGrids WMS | แผนที่ดิน 250 m และค่าที่จุดในฟังก์ชันตรวจดิน | เว็บเรียกตรง (GetMap ผ่าน SLD, GetFeatureInfo) |

**ชั้นพื้นที่**

| แหล่ง | ประเภท | วิธีใช้ |
|---|---|---|
| OCHA / กรมแผนที่ทหาร – COD-AB (humdata)<br><https://data.humdata.org/dataset/cod-ab-tha> | ขอบเขตจังหวัด/อำเภอ/ตำบล (CC BY-IGO) | `scripts/build_boundaries.py` — ขอบเขตหลักของทุกชั้น (ตรวจพิกัด ชื่อพื้นที่ ชั้นแผนที่) |
| Esri / Impact Observatory – Sentinel-2 10 m Land Cover | การใช้ที่ดินรายปี (CC BY 4.0) | เว็บเรียก ImageServer ตรง อ่านปีที่มีจาก timeInfo |
| กรมพัฒนาที่ดิน – ชุดดิน, กลุ่มชุดดิน, การใช้ที่ดิน | แผนที่ (CC BY-NC-ND) | ให้เฉพาะลิงก์ + เฝ้าดูฉบับใหม่จาก metadata |

### Procedure ที่ใช้ (อ่านอย่างเดียว)

| sp | criteria | ใช้ทำอะไร |
|---|---|---|
| `Province_List` | `{}` | รายชื่อและรหัสจังหวัด |
| `DB_PieChart_Public` | `{"areaCode": "p40"}` | ตรวจจำนวนจุดของจังหวัดก่อนดึง (ผลรวมของ `data3`) |
| `SurveySearch_Public` | `{"areaCode": "p40", "soilName": ""}` | รายการจุดทั้งจังหวัด |
| `SurveyDetail_Public` | `{"h_id": 1004}` | รายละเอียดจุด (ตำบล/อำเภอ/จังหวัด, เนื้อดิน) |

รหัสพื้นที่: `p` + รหัสจังหวัด (เช่น `p40`) หรือ `a` + รหัสอำเภอ (เช่น `a4001`)

## รายละเอียดแหล่งข้อมูล

### LDD Catalog (CKAN) — <https://lddcatalog.ldd.go.th/group/soil>

API: `https://lddcatalog.ldd.go.th/api/3/action/package_search?fq=groups:soil`

| ชุดข้อมูล | ไฟล์ | สัญญาอนุญาต |
|---|---|---|
| `ldd_11_01` ข้อมูลชุดดิน 1:25,000 | SHP (.rar) รายจังหวัด 77 ไฟล์ — `tswc.ldd.go.th/DownloadGIS/Index_Soil.html` | **CC BY-NC-ND** |
| `oss01` กลุ่มชุดดิน 62 กลุ่ม 1:25,000 | SHP (.rar) รายจังหวัด 78 ไฟล์ + พจนานุกรมข้อมูล CSV | **CC BY-NC-ND** |
| `osd01` การตรวจวิเคราะห์ดิน | JSON API `osd101.ldd.go.th/api/data.php` | CC BY |
| `ldd_21_01` การใช้ที่ดิน | ZIP รายจังหวัด 77 ไฟล์ — `tswc.ldd.go.th/DownloadGIS/Index_Lu.html` | **CC BY-NC-ND** |
| ชุดอื่น: ความเหมาะสมของที่ดิน, การชะล้างพังทลาย, ดินถล่ม, แล้งซ้ำซาก | SHP | CC BY-NC-ND |

- ไฟล์ SHP ให้ `Last-Modified`/`ETag` ผ่าน HEAD จึงตรวจการเปลี่ยนแปลงได้โดยไม่ต้องดาวน์โหลด (เช่น `sr_cmi.rar` 14 MB, แก้ล่าสุด 29 เม.ย. 2024)
- **ND (No Derivatives)**: ห้ามเผยแพร่ฉบับแปลง/ดัดแปลง จึงไม่นำ SHP หรือฉบับแปลงขึ้น repo สาธารณะ เก็บเฉพาะ metadata และลิงก์ ไฟล์จริงใช้วิเคราะห์ในเครื่องเท่านั้น
- **การใช้ที่ดิน** สำรวจหมุนเวียนปีละ ~12–16 จังหวัด (ฉบับปัจจุบันปี 2563–2568) และเว็บต้นทางมีเฉพาะฉบับล่าสุด ปีสำรวจอยู่ในชื่อไฟล์ใน ZIP (เช่น `LU_CMI_2567.shp`) อ่านได้จากท้ายไฟล์ด้วย HTTP Range โดยไม่ต้องดาวน์โหลด → `data/ref/landuse_state.json`
- ไฟล์ของ LDD ไม่สม่ำเสมอ: ชื่อไฟล์ใน ZIP ปน UTF-8/TIS-620, บางไฟล์มี ZIP ซ้อน หรือชุดไฟล์ซ้ำ, `.cpg` ไม่ตรงกับรหัสจริง, ขอบเขตจังหวัดที่แนบมาไม่ตรงกับ humdata

### ผลวิเคราะห์ดิน (osd101) — ค่าตัวเลขจริง

พารามิเตอร์: `parameterID` (235 pH, 141 EC, 175 K, 174 P, 172 OM), `year` (พ.ศ.), `startdate`/`enddate` (dd/mm/yyyy พ.ศ.), `provinceName`, `max` (สูงสุด 1,000), `page` (หน้าถัดไป)

ผลทดสอบ:
- `startdate`/`enddate` ใช้ได้ แต่ **`parameterID` ถูกละเลย** (ได้ทั้ง 5 ค่าเสมอ)
- เพดาน 1,000 แถวต่อคำขอ (ประมาณ 200 ตัวอย่าง) จึงแบ่งช่วงวันที่ให้แคบ วันที่ยังเต็มใช้ `page` ดึงหน้าถัดไป
- วันที่เป็นข้อความไทย พ.ศ. (เช่น "23 กันยายน พ.ศ. 2569") และมีวันที่ในอนาคต (ธ.ค. 2569) ต้องตรวจสอบ
- พิกัดมีทศนิยม 3 ตำแหน่ง (ประมาณ ±100 m) ชื่อพารามิเตอร์มี HTML (`<sup>`)
- ไม่มีรหัสตัวอย่าง ต้องสร้าง key จาก (lat, lon, date, district)

### ISRIC WoSIS — soil profile

WFS: `https://maps.isric.org/mapserv?map=/map/wosis_latest.map` ชั้น `wosis_latest_profiles` และชั้นละคุณสมบัติ (`phaq`, `phkc`, `orgc`, `nitkjd`, `clay`, `silt`, `sand`, `cecph7`, `bdfiod`, `elco25`) กรองด้วย `country_name = Thailand`, ขอผลเป็น GeoJSON

ผลทดสอบ (ต.ค. 2026):
- 451 profile ในไทย: WD-WISE 277, WD-ISCN 112, US-NCSS 28, WD-Mangroves 20, WD-ISIS 12, WD-NWAFU-SCS 2
- สัญญาอนุญาตระบุ **ต่อแถว** (`licence`): CC BY 3.0/4.0, CC0, U.S. Public Domain — สคริปต์ตัดชุดที่เป็น NC/ND ออกอัตโนมัติ (ตอนนี้ไม่มี)
- 216 profile ไม่มีปีที่สำรวจ, ทุก profile มีพิกัด (ความคลาดเคลื่อนระบุใน `positional_uncertainty`)
- `value_avg` คือค่าเฉลี่ยเมื่อชั้นเดียวมีหลายค่า, วิธีวิเคราะห์อยู่ใน `method_options`
- profile ซ้ำข้ามชุดข้อมูล (WISE กับ US-NCSS/ISIS) ถูกติดธง `duplicate`; เทียบกับจุดสำรวจ LDD แล้วไม่พบจุดเดียวกัน (สำรวจคนละยุค)
- ตำบลจากขอบเขต humdata, พิกัดซ้ำกับ profile หรือแหล่งอื่นติดธง `shared_coords`

### Google Earth Engine (ตัวแปรร่วม / เทียบค่า)

| Asset | เนื้อหา |
|---|---|
| `OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02` | pH 6 ความลึก, 250 m |
| `OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02` | อินทรีย์คาร์บอน |
| `OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02` (+ SAND) | ดินเหนียว / ทราย |
| `OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02` | ชั้นเนื้อดิน USDA |
| `projects/soilgrids-isric/*_mean` (community catalog) | SoilGrids 2.0 |
| `projects/sat-io/open-datasets/FAO/GSOCMAP1-5-0` | FAO GSOCmap v1.5 คาร์บอนสะสม 0–30 cm |

แนวทาง: สุ่มค่าที่จุดข้อมูลด้วย `reduceRegions` (ผลวิเคราะห์ดินใช้พิกัดเป็น key ที่เดียวกันหลายวันสุ่มครั้งเดียว) และส่งออกภาพทั้งประเทศ ~1 km สำหรับชั้นแผนที่ (จัดชั้นด้วย `site/scales.js`) ใช้ Earth Engine แบบไม่เชิงพาณิชย์

### data.go.th — ผลการค้นหา (ต.ค. 2026)

ค้นคำว่า "ดิน" ได้ 2,282 ชุด ส่วนใหญ่ไม่ใช่ข้อมูลดิน (ที่ดิน, การใช้ที่ดิน) ชุดที่เกี่ยวข้อง:
- **osd02 บัตรดินดี** (LDD, CC BY) — ผลวิเคราะห์รายตัวอย่าง 13,855 แถว → นำเข้าแล้ว
- ตาราง "ข้อมูลค่าวิเคราะห์ดินในแต่ละพื้นที่" / "ข้อมูลชุดดิน" ของสำนักงานจังหวัด — เป็นช่วง pH ตามคำบรรยายชุดดิน (เช่น "5.0-6.5") ไม่ใช่ค่าวัด แต่ละจังหวัดใช้รูปแบบต่างกัน → ยังไม่นำเข้า
- ชุดของ LDD ที่เป็นแผนที่ (ldd_11_01, oss01, เขตความเหมาะสม) — CC BY-NC-ND → ให้เฉพาะลิงก์

## แหล่งที่จะเพิ่มในอนาคต

| แหล่ง | ประเภท | หมายเหตุ |
|---|---|---|
| FAO HWSD v2.0 | Raster ~1 km | หน่วยแผนที่ดินโลก |
| FAO GSP (GSASmap, GSNmap) | Raster | ยังไม่มีใน Earth Engine (GSOCmap ใช้แล้ว) |
| LDD แผนที่ชุดดิน / กลุ่มชุดดิน / การใช้ที่ดิน บนเว็บ | Polygon | รอการอนุญาตจาก LDD (CC BY-NC-ND) ตอนนี้ให้ลิงก์ |
| data.go.th ตารางชุดดินรายจังหวัด | CSV/XLSX | ค่าบรรยายของชุดดิน ไม่ใช่ค่าวัด รูปแบบต่างกันทุกจังหวัด |
| GISTDA ความชื้นในดินรายสัปดาห์ | API | ต้องใช้ API key, เป็นอนุกรมเวลา |
| Agri-Map Online | แผนที่ความเหมาะสม | ตัวแปรร่วม |
