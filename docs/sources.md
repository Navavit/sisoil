# แหล่งข้อมูลดินแบบเปิดของประเทศไทย

## ที่ใช้อยู่ในระบบ

| แหล่ง | ประเภท | วิธีดึง | สถานะ |
|---|---|---|---|
| กรมพัฒนาที่ดิน – Soil Survey Public<br><https://soilservice.ldd.go.th/soilsurveypublic/> | จุดสำรวจ (pH, OM, P, K, เนื้อดิน, พิกัด) | `scripts/fetch_ldd.py` ผ่าน `POST /SoilSurveyAPI/api/SP` ใช้เฉพาะ procedure สาธารณะแบบอ่านอย่างเดียว | ใช้งาน |
| กรมพัฒนาที่ดิน – ผลวิเคราะห์ดิน (osd01) | ค่าตัวเลข pH, EC, OM, P, K | `scripts/fetch_osd.py` (รายละเอียดด้านล่าง) | ใช้งาน |
| ISRIC WoSIS<br><https://www.isric.org/explore/wosis> | soil profile แยกชั้นความลึก + ผลแล็บ | `scripts/fetch_wosis.py` ผ่าน WFS (รายละเอียดด้านล่าง) | ใช้งาน |
| Google Earth Engine – OpenLandMap, SoilGrids | ค่าที่จุดสำรวจ | `scripts/sample_gee.py` | ใช้งาน |

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
| ชุดอื่น: ความเหมาะสมของที่ดิน, การชะล้างพังทลาย, ดินถล่ม, แล้งซ้ำซาก, การใช้ที่ดิน | SHP | CC BY-NC-ND |

- ไฟล์ SHP ให้ `Last-Modified`/`ETag` ผ่าน HEAD จึงตรวจการเปลี่ยนแปลงได้โดยไม่ต้องดาวน์โหลด (เช่น `sr_cmi.rar` 14 MB, แก้ล่าสุด 29 เม.ย. 2024)
- **ND (No Derivatives)**: ห้ามเผยแพร่ฉบับแปลง/ดัดแปลง จึงไม่ควรนำ SHP หรือฉบับแปลงขึ้น repo สาธารณะ ให้เก็บเฉพาะ metadata และลิงก์ ส่วนตัวไฟล์ดาวน์โหลดมาใช้ในเครื่อง (`raw/` ซึ่งอยู่ใน .gitignore)

### ผลวิเคราะห์ดิน (osd101) — ค่าตัวเลขจริง

พารามิเตอร์: `parameterID` (235 pH, 141 EC, 175 K, 174 P, 172 OM), `year` (พ.ศ.), `startdate`/`enddate` (dd/mm/yyyy พ.ศ.), `provinceName`, `max` (สูงสุด 1,000)

ผลทดสอบ:
- `startdate`/`enddate` ใช้ได้ แต่ **`parameterID` ถูกละเลย** (ได้ทั้ง 5 ค่าเสมอ)
- เพดาน 1,000 แถวต่อคำขอ (ประมาณ 200 ตัวอย่าง) จึงต้องแบ่งช่วงวันที่ให้แคบ แล้วแบ่งย่อยตามจังหวัดถ้าเต็ม 1,000
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
- ยังไม่ได้ตัดซ้ำกับ LDD (profile ใน WISE บางส่วนมาจาก LDD เดิม)

### Google Earth Engine (ตัวแปรร่วม / เทียบค่า)

| Asset | เนื้อหา |
|---|---|
| `OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02` | pH 6 ความลึก, 250 m |
| `OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02` | อินทรีย์คาร์บอน |
| `OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02` (+ SAND) | ดินเหนียว / ทราย |
| `OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02` | ชั้นเนื้อดิน USDA |
| `projects/soilgrids-isric/*_mean` (community catalog) | SoilGrids 2.0 |

แนวทาง: สุ่มค่าที่จุดสำรวจด้วย `sampleRegions` ต้องใช้บัญชี GEE และ Cloud project

## แหล่งที่จะเพิ่มในอนาคต

| แหล่ง | ประเภท | หมายเหตุ |
|---|---|---|
| ISRIC SoilGrids 250 m | Raster | ค่าคุณสมบัติดินหลายความลึก |
| FAO HWSD v2.0 | Raster ~1 km | หน่วยแผนที่ดินโลก |
| FAO GSP (GSOCmap, GSASmap, GSNmap) | Raster | ไทยส่งข้อมูลระดับชาติ |
| LDD แผนที่กลุ่มชุดดิน / ชุดดิน | Polygon | ต้องตรวจช่องทางดาวน์โหลด/ขอข้อมูล |
| data.go.th (ชุดข้อมูลของ LDD) | SHP/CSV | Open Government License |
| Agri-Map Online | แผนที่ความเหมาะสม | ตัวแปรร่วม |
