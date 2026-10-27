# สถาปัตยกรรมระบบ

## 1. การไหลของข้อมูล (Data flow)

```mermaid
flowchart TD
    subgraph LDD["กรมพัฒนาที่ดิน — soilservice.ldd.go.th"]
        API[("SoilSurveyAPI<br/>POST /api/SP")]
    end

    subgraph GHA["GitHub Actions — update-data.yml (รายเดือน)"]
        A[Province_List<br/>รายชื่อ 77 จังหวัด] --> B{DB_PieChart_Public<br/>จำนวนจุดเท่ากับรอบก่อน?}
        B -- "เท่าเดิม" --> S[ข้ามจังหวัดนี้<br/>ใช้ข้อมูลเดิม]
        B -- "เปลี่ยน / --full" --> C[SurveySearch_Public<br/>ดึงรายการจุดทั้งจังหวัด]
        C --> N[ทำความสะอาดข้อมูล<br/>วันที่ ISO · แยก UTM X/Y]
        S --> M
        N --> M[รวมกับข้อมูลเดิม<br/>คงรายละเอียดที่เคยดึงแล้ว]
        M --> D{จุดนี้มีรายละเอียดแล้ว?}
        D -- "ยัง (ไม่เกิน MAX_DETAILS)" --> E[SurveyDetail_Public<br/>ตำบล/อำเภอ/จังหวัด · เนื้อดิน]
        D -- "มีแล้ว" --> U
        E --> U[แปลง UTM → WGS84<br/>จุดที่ไม่มี lat/lon]
        U --> Q[ตรวจคุณภาพ<br/>ติดธง qa_flags]
        Q --> X[เทียบกับรอบก่อน<br/>เพิ่ม / ลบ / แก้ไข]
    end

    API -.-> A & B & C & E

    X --> F1[(data/ldd/points.json<br/>.geojson · .csv)]
    X --> F2[(data/ldd/state.json<br/>จำนวนจุดรายจังหวัด)]
    X --> F3[(data/changes/วันที่.json<br/>data/changelog.json)]
    X -- "มีการเปลี่ยนแปลง" --> I[GitHub Issue แจ้งเตือน]

    F1 & F3 --> G[git commit → main]
    G --> P[pages.yml<br/>Deploy GitHub Pages]
    P --> W[เว็บไซต์<br/>แผนที่ · ตัวกรอง · ดาวน์โหลด]

    F1 -. "ใช้ในเครื่อง (ไม่ขึ้น GitHub)" .-> NB[notebooks/<br/>Jupyter วิเคราะห์ซ้ำได้]
```

### ผลวิเคราะห์ดิน (osd101) และ Google Earth Engine

```mermaid
flowchart TD
    OSD[("osd101.ldd.go.th<br/>api/data.php")] -.-> M1
    subgraph OSDF["fetch_osd.py"]
        M1{เดือนนี้ดึงแล้ว?<br/>state.json} -- "แล้ว (เก่ากว่า 60 วัน)" --> SKIP2[ข้าม]
        M1 -- "ยัง / ช่วงล่าสุด" --> M2[ขอทั้งเดือน]
        M2 --> M3{ได้ 1,000 แถว?}
        M3 -- "ไม่" --> M5
        M3 -- "เต็ม" --> M4[แตกเป็นรายวัน<br/>วันที่ยังเต็ม → capped_days]
        M4 --> M5[แปลงวันที่ พ.ศ. · ตัด HTML<br/>ตรวจช่วงค่า]
        M5 --> M6[(measurements_ปี.csv.gz<br/>1 แถว = 1 ค่าวัด)]
        M6 --> M7[(sites_ปี.json<br/>median/min/max/n ต่อที่ตั้ง+วัน)]
    end
    subgraph GEEF["sample_gee.py"]
        G1{จุดนี้สุ่มแล้ว<br/>และพิกัดไม่เปลี่ยน?} -- "ใช่" --> SKIP3[ข้าม]
        G1 -- "ไม่" --> G2[reduceRegions<br/>OpenLandMap + SoilGrids]
        G2 --> G3[(data/gee/covariates.csv)]
    end
    M7 --> G1
    LDDP[(data/ldd/points.json)] --> G1
    GEE[("Google Earth Engine")] -.-> G2
```

### หลักการไม่ดึงข้อมูลซ้ำ

1. **ตรวจจำนวนก่อน**: เรียก `DB_PieChart_Public` ซึ่งตอบกลับขนาดเล็ก ผลรวมของ `data3` เท่ากับจำนวนจุดในจังหวัด ถ้าเท่ากับค่าใน `state.json` จะข้ามจังหวัดนั้น
2. **รายละเอียดดึงครั้งเดียว**: `SurveyDetail_Public` เรียกเฉพาะจุดที่ยังไม่มีฟิลด์ `province` และจำกัดจำนวนต่อรอบด้วย `MAX_DETAILS`
3. **ตรวจแบบเต็มปีละครั้ง** (รอบเดือนมกราคม) หรือสั่งเองด้วย `full=true` เพื่อจับการแก้ไขข้อมูลที่ไม่ได้เปลี่ยนจำนวนจุด

## 2. ER diagram

ตอนนี้ข้อมูลเก็บเป็นไฟล์ JSON/CSV ใน `data/` โครงสร้างด้านล่างคือแบบจำลองเชิงตรรกะ ซึ่งนำไปสร้างตารางใน PostGIS/SQLite ได้ตรงตัว ตารางที่มีคำว่า *(แผน)* ยังไม่ได้ดึงข้อมูล

```mermaid
erDiagram
    PROVINCE ||--o{ SURVEY_POINT : "มี"
    SURVEY_POINT }o--o| SOIL_SERIES : "จัดเป็น (แผน)"
    SURVEY_POINT ||--o{ HORIZON : "มีชั้นดิน (แผน)"
    HORIZON ||--o{ LAB_RESULT : "ผลวิเคราะห์ (แผน)"
    UPDATE_RUN ||--o{ CHANGE_ITEM : "บันทึก"
    ANALYSIS_SITE ||--|{ MEASUREMENT : "สรุปจาก"
    SURVEY_POINT ||--o| GEE_COVARIATE : "ค่าจาก GEE"
    ANALYSIS_SITE ||--o| GEE_COVARIATE : "ค่าจาก GEE"
    SURVEY_POINT ||--o{ CHANGE_ITEM : "ถูกเปลี่ยนแปลง"
    PROVINCE ||--o{ PROVINCE_CHECK : "ตรวจจำนวนแต่ละรอบ"

    PROVINCE {
        string code PK "เช่น 40"
        string name "KHON KAEN"
        int count "จำนวนจุดจากตัวนับ"
        int points "จำนวนจุดที่ดึงได้"
        date checked_at
    }
    SURVEY_POINT {
        int id PK "h_id ของ LDD"
        string province_code FK
        date date "วันที่สำรวจภาคสนาม (LDD)"
        date first_seen "วันที่ระบบเก็บเข้าครั้งแรก"
        date last_seen "วันที่พบล่าสุดในรายการต้นทาง"
        date detail_fetched_at "วันที่ดึงรายละเอียด"
        float lat "WGS84"
        float lon "WGS84"
        string coord_source "ldd | utm"
        string utm_zone
        float utm_x
        float utm_y
        int utm_zone_fixed "โซนที่แก้ไข (ถ้ามี)"
        string location "ตำบล, อำเภอ, จังหวัด"
        string subdistrict
        string district
        string province
        string ph "ระดับความเป็นกรด-ด่าง"
        string om "ระดับอินทรียวัตถุ"
        string p "ระดับฟอสฟอรัส"
        string k "ระดับโพแทสเซียม"
        string texture_field "เนื้อดินภาคสนาม"
        string texture_lab "เนื้อดินห้องปฏิบัติการ"
        list qa_flags "ธงคุณภาพข้อมูล"
    }
    SOIL_SERIES {
        string code PK "เช่น Ki, Ng, Bpi"
        string name_th
        string name_en
        int soil_group "กลุ่มชุดดิน 1-62"
    }
    HORIZON {
        int point_id FK
        int layer_no PK
        int depth_top_cm
        int depth_bottom_cm
        string designation
        string color_munsell
    }
    LAB_RESULT {
        int point_id FK
        int layer_no FK
        string parameter "pH, OM, CEC ..."
        float value
        string unit
    }
    ANALYSIS_SITE {
        string id PK "hash(วันที่, พิกัด, ที่ตั้ง)"
        date date "วันที่วิเคราะห์"
        float lat
        float lon
        string province
        string amphur
        string district
        int n_samples
        float ph "median"
        float ec_ds_m "median"
        float om_pct "median"
        float p_mg_kg "median"
        float k_mg_kg "median"
        list qa_flags
    }
    MEASUREMENT {
        string id PK "hash(..., ลำดับ)"
        string site_id FK
        string param "ph | ec_ds_m | om_pct | p_mg_kg | k_mg_kg"
        float value
        string value_text "ค่าที่ไม่ใช่ตัวเลข"
        date first_seen
    }
    GEE_COVARIATE {
        string source PK "ldd | osd"
        string id PK
        float olm_ph_0cm
        float olm_oc_g_kg_0cm
        float olm_clay_pct_0cm
        float sg_ph_0_5cm
        float sg_soc_g_kg_0_5cm
    }
    UPDATE_RUN {
        date date PK
        int total
        int added
        int removed
        int modified
        int details_pending
    }
    CHANGE_ITEM {
        date run_date FK
        int point_id FK
        string change_type "added | removed | modified"
        json before
        json after
    }
    PROVINCE_CHECK {
        string province_code FK
        date checked_at
        int count
    }
```

### การจัดการข้อมูลไม่สะอาด (Data quality)

ข้อมูลต้นทางมีปัญหาหลายแบบ ระบบ **ไม่ลบและไม่แก้ค่าต้นฉบับ** แต่จะติดธงไว้ใน `qa_flags` ให้ผู้ใช้กรองเอง สรุปจำนวนแต่ละธงอยู่ใน `data/meta.json` → `qa`

| ธง | ความหมาย | ตัวอย่างที่พบ (ขอนแก่น) |
|---|---|---|
| `no_coords` | ไม่มีพิกัดที่ใช้ได้ | ไม่มีทั้ง lat/lon และ UTM |
| `utm_converted` | lat/lon ว่าง แต่แปลงได้จาก UTM | ประมาณ 57% ของจุด |
| `utm_zone_fixed` | โซน UTM ที่ระบุไม่ตรงกับค่า X | ระบุ 47 แต่ค่า X อยู่ในโซน 48 |
| `far_from_province` | ห่างจากค่ากลางของจังหวัดเกิน ~150 km | |
| `province_mismatch` | จังหวัดใน `location` ไม่ตรงกับจังหวัดที่ค้นหา | |
| `no_location` | ไม่มีชื่อตำแหน่ง | |
| `date_missing` / `date_future` / `date_too_old` | วันที่ผิดปกติ | |
| `ph_unknown` / `nutrient_unknown` | ค่าเป็น `Other` หรือว่าง | |
| `duplicate` | พิกัดและวันที่ซ้ำกับจุดอื่น (จุดที่ id น้อยกว่าไม่ถูกติดธง) | |

การตรวจสอบเพิ่มเติม: lat/lon ที่ LDD ให้มาตรงกับค่า UTM ภายใน 1 km ทุกจุด (350/350) ปัญหาจึงอยู่ที่ฟิลด์โซนของจุดที่ไม่มี lat/lon

### วันที่ของข้อมูลแต่ละจุด

| ฟิลด์ | ความหมาย | ที่มา |
|---|---|---|
| `date` | วันที่ลงพื้นที่เก็บตัวอย่างดิน | LDD |
| `first_seen` | วันที่ระบบนี้พบจุดครั้งแรก (ไม่เปลี่ยนอีก) | ระบบนี้ |
| `last_seen` | วันที่ล่าสุดที่จุดยังปรากฏในรายการของ LDD | ระบบนี้ |
| `detail_fetched_at` | วันที่ดึงรายละเอียด (ตำบล/อำเภอ/เนื้อดิน) | ระบบนี้ |

ฟิลด์ของระบบไม่นับเป็น "การแก้ไขข้อมูล" ตอนเทียบรอบ

### ไฟล์ที่สอดคล้องกับแต่ละ entity

| Entity | ไฟล์ |
|---|---|
| `SURVEY_POINT` | `data/ldd/points.json`, `points.geojson`, `points.csv` |
| `PROVINCE` / `PROVINCE_CHECK` | `data/ldd/state.json` |
| `UPDATE_RUN` | `data/changelog.json` |
| `CHANGE_ITEM` | `data/changes/<date>.json` |
| `ANALYSIS_SITE` | `data/osd/sites_<ปี>.json`, `sites.csv` |
| `MEASUREMENT` | `data/osd/measurements_<ปี>.csv.gz` |
| `GEE_COVARIATE` | `data/gee/covariates.csv` |
