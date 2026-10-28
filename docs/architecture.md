# สถาปัตยกรรมระบบ

## 1. ภาพรวม

```mermaid
flowchart LR
    subgraph SRC["แหล่งข้อมูลเปิด"]
        LDD1[("LDD Soil Survey Public<br/>จุดสำรวจภาคสนาม")]
        LDD2[("LDD osd101<br/>ผลวิเคราะห์จากห้องแล็บ")]
        LDD3[("LDD lddcatalog<br/>บัตรดินดี")]
        ISRIC[("ISRIC WoSIS<br/>soil profile")]
        GEE[("Google Earth Engine<br/>OpenLandMap · SoilGrids · FAO GSOCmap")]
        HDX[("humdata COD-AB<br/>ขอบเขตปกครอง")]
    end

    subgraph GHA["GitHub Actions — รายเดือน"]
        F[ดึงเฉพาะส่วนที่เปลี่ยน] --> C[ทำความสะอาด<br/>ตรวจกับขอบเขต humdata<br/>ติดธงคุณภาพ]
        C --> D[เทียบรอบก่อน]
        MON[เฝ้าดู metadata<br/>แหล่งอ้างอิง · การใช้ที่ดิน LDD]
    end

    LDD1 & LDD2 & LDD3 & ISRIC -.-> F
    GEE -.-> C
    HDX -. "ครั้งเดียว / เมื่อมีฉบับใหม่" .-> REF[(data/ref/boundaries)]
    REF --> C
    D --> DATA[(data/)]
    D -- "มีของใหม่" --> I[GitHub Issue]
    MON -- "มีฉบับใหม่" --> I
    DATA --> B[build_web.py<br/>กริด · ชื่อพื้นที่ · บัตรดินดีตามรหัส]
    B --> W[GitHub Pages]
    SG[("SoilGrids WMS · Esri Land Cover<br/>เรียกสดจากเบราว์เซอร์")] -.-> W
```

หลักสำคัญ:

1. **ตรวจก่อนดึง** — นับจำนวนจุด, ETag/Last-Modified หรือ metadata ก่อน ดึงเฉพาะส่วนที่เปลี่ยน
2. **ไม่แก้ค่าต้นฉบับ** — ติดธง `qa_flags` แทนการลบหรือแก้ แก้เฉพาะที่พิสูจน์ได้และเก็บค่าเดิมไว้
3. **ขอบเขตปกครองชุดเดียว** — ทุกแหล่งตรวจพิกัดและได้ชื่อพื้นที่จากขอบเขต humdata (`adm_tambon`)
4. **เว็บแสดงเฉพาะที่มั่นใจตำแหน่ง** — ข้อมูลอื่นยังอยู่ใน `data/` พร้อมธง

## 2. การไหลของข้อมูลแต่ละแหล่ง

### จุดสำรวจภาคสนาม (`fetch_ldd.py`)

```mermaid
flowchart TD
    A[รายชื่อ 77 จังหวัด] --> B{จำนวนจุดเท่ารอบก่อน?}
    B -- "เท่าเดิม" --> S[ข้ามจังหวัดนี้]
    B -- "เปลี่ยน" --> C[ดึงรายการจุดทั้งจังหวัด]
    C --> M[รวมกับข้อมูลเดิม]
    S --> M
    M --> D{มีรายละเอียดแล้ว?}
    D -- "ยัง" --> E[ดึงรายละเอียด<br/>ตำบล · อำเภอ · เนื้อดิน]
    D -- "มีแล้ว" --> U
    E --> U[แปลง UTM → WGS84<br/>เลือกโซนที่ตกในจังหวัดที่ระบุ]
    U --> Q[ตรวจกับขอบเขต humdata<br/>พิกัดซ้ำข้ามแหล่ง · ติดธง]
    Q --> X[เทียบรอบก่อน → changelog]
```

### ผลวิเคราะห์จากห้องแล็บ (`fetch_osd.py`)

```mermaid
flowchart TD
    M1{เดือนนี้ดึงแล้ว?} -- "แล้ว (เก่ากว่า 60 วัน)" --> SKIP[ข้าม]
    M1 -- "ยัง / ช่วงล่าสุด" --> M2[ขอทั้งเดือน]
    M2 --> M3{ได้ 1,000 แถว?}
    M3 -- "ไม่" --> M5
    M3 -- "เต็ม" --> M4[แตกเป็นรายวัน<br/>วันที่ยังเต็ม → page 2, 3, ...]
    M4 --> M5[แปลงวันที่ พ.ศ. · ตรวจช่วงค่า]
    M5 --> M6[(measurements_ปี.csv.gz<br/>1 แถว = 1 ค่าวัด)]
    M6 --> M7[(sites_ปี.json<br/>ค่ากลางต่อที่ตั้ง+วัน)]
    M7 --> Q2[ตรวจกับขอบเขต humdata<br/>พิกัดซ้ำ · ติดธง]
```

### แหล่งอื่น

| สคริปต์ | วิธีไม่ดึงซ้ำ | ทำความสะอาด |
|---|---|---|
| `fetch_wosis.py` | เทียบ hash ราย profile | ตัดชุดข้อมูล NC/ND, ตัด profile ซ้ำข้ามชุดข้อมูล, เฉลี่ยถ่วงความหนา 0–30 cm, ขอบเขต humdata |
| `fetch_dindee.py` | ETag / Last-Modified ของไฟล์ | แยกระดับกับช่วงค่า, จับคู่ชื่อตำบลกับรหัส humdata ตอนสร้างไฟล์เว็บ |
| `sample_gee.py` | สุ่มเฉพาะจุดใหม่ (ผลวิเคราะห์ดินใช้พิกัดเป็น key) | — |
| `check_static_sources.py`, `check_landuse.py` | อ่าน metadata / ชื่อไฟล์ท้าย ZIP เท่านั้น | — |

### เว็บไซต์

```mermaid
flowchart LR
    DATA[(data/)] --> BW[build_web.py ตอน deploy]
    BW --> G[(grid/ 0.5°<br/>ค่าวัด + ค่า GEE ที่มั่นใจตำแหน่ง)]
    BW --> N[(admin_names.json<br/>ชื่อพื้นที่ humdata)]
    BW --> DD[(dindee.json<br/>ตามรหัสตำบล humdata)]
    SC[site/scales.js<br/>ช่วงชั้น + ชุดสี] --> WEB[แผนที่ · คำอธิบายสี]
    SC --> BR[build_rasters.py<br/>ภาพแผนที่ดินจาก GEE]
    SC --> SLD[SoilGrids WMS ผ่าน SLD]
    G & N & DD --> CHK[ตรวจดินจากพิกัด]
```

## 3. ER diagram

ข้อมูลเก็บเป็นไฟล์ JSON/CSV/Parquet ใน `data/` โครงสร้างด้านล่างคือแบบจำลองเชิงตรรกะ นำไปสร้างตารางใน PostGIS/SQLite ได้ตรงตัว

```mermaid
erDiagram
    ADMIN_AREA ||--o{ SURVEY_POINT : "adm_tambon"
    ADMIN_AREA ||--o{ ANALYSIS_SITE : "adm_tambon"
    ADMIN_AREA ||--o{ WOSIS_PROFILE : "adm_tambon"
    ADMIN_AREA ||--o{ DINDEE_SUMMARY : "รหัสพื้นที่"
    WOSIS_PROFILE ||--|{ WOSIS_LAYER : "ชั้นดิน"
    ANALYSIS_SITE ||--|{ MEASUREMENT : "สรุปจาก"
    SURVEY_POINT ||--o| GEE_COVARIATE : "ค่าจาก GEE"
    ANALYSIS_SITE ||--o| GEE_COVARIATE : "ค่าจาก GEE (ตามพิกัด)"
    WOSIS_PROFILE ||--o| GEE_COVARIATE : "ค่าจาก GEE"
    WOSIS_PROFILE |o--o| SURVEY_POINT : "อาจเป็นจุดเดียวกัน (ldd_match)"
    UPDATE_RUN ||--o{ CHANGE_ITEM : "บันทึก"
    SURVEY_POINT ||--o{ CHANGE_ITEM : "ถูกเปลี่ยนแปลง"

    ADMIN_AREA {
        string code PK "จังหวัด 2 หลัก / อำเภอ 4 / ตำบล 6 (humdata)"
        string th
        string en
    }
    SURVEY_POINT {
        int id PK "h_id ของ LDD"
        string province_code
        date date "วันที่สำรวจภาคสนาม"
        date first_seen
        date last_seen
        float lat
        float lon
        string coord_source "ldd | utm"
        string adm_tambon FK
        string ph "ระดับ"
        string om "ระดับ"
        string p "ระดับ"
        string k "ระดับ"
        string texture_field
        list qa_flags
    }
    ANALYSIS_SITE {
        string id PK "hash(วันที่, พิกัด, ที่ตั้ง)"
        date date "วันที่ส่งผลวิเคราะห์"
        float lat
        float lon
        string adm_tambon FK
        int n_samples
        float ph "median"
        float ec_ds_m
        float om_pct
        float p_mg_kg
        float k_mg_kg
        list qa_flags
    }
    MEASUREMENT {
        string id PK
        string site_id FK
        string param
        float value
        string value_text
    }
    WOSIS_PROFILE {
        int id PK
        string dataset
        date date "ปีที่สำรวจ"
        float lat
        float lon
        string adm_tambon FK
        float ph_h2o_0_30
        float orgc_g_kg_0_30
        float clay_pct_0_30
        string duplicate_of
        list qa_flags
    }
    WOSIS_LAYER {
        int profile_id FK
        int upper_cm
        int lower_cm
        string property
        float value
    }
    DINDEE_SUMMARY {
        string area_code FK
        int n
        json ph "จำนวนต่อระดับ"
        json n_ "จำนวนต่อระดับ"
        json p
        json k
    }
    GEE_COVARIATE {
        string source PK "ldd | osd | wosis"
        string id PK
        float olm_ph_0cm
        float sg_ph_0_5cm
        float sg_soc_g_kg_0_5cm
        float gsoc_t_ha_0_30cm
    }
    UPDATE_RUN {
        date date PK
        int total
        int added
        int removed
        int modified
    }
    CHANGE_ITEM {
        date run_date FK
        int point_id FK
        string change_type
    }
```

ชุดดิน กลุ่มชุดดิน และการใช้ที่ดินของ LDD (CC BY-NC-ND) ไม่อยู่ในแบบจำลองนี้ เว็บให้เฉพาะลิงก์ ระบบเก็บแค่ metadata (`data/ref/sources_state.json`, `data/ref/landuse_state.json`)

## 4. ธงคุณภาพที่ทำให้ไม่แสดงบนเว็บ

| ธง | ความหมาย |
|---|---|
| `no_coords` / `outside_thailand` | ไม่มีพิกัด หรือนอกประเทศ |
| `far_from_province` | อยู่นอกขอบเขตจังหวัดที่ระบุ (humdata) เกิน 1 km |
| `off_land` | ไม่อยู่ในจังหวัดใดและห่างฝั่งเกิน 1 km |
| `amphoe_mismatch` | อำเภอที่ระบุไม่ตรงกับพิกัด |
| `shared_coords` | พิกัดซ้ำกับข้อมูลอื่น ไม่ว่าแหล่งเดียวกันหรือต่างแหล่ง |
| `duplicate` / `multi_sample` | ข้อมูลซ้ำ หรือหลายตัวอย่างในพิกัดเดียว |
| `no_location` / `date_future` | ไม่มีชื่อสถานที่ / วันที่ในอนาคต |

รายละเอียดและตัวเลขจริงอยู่ใน [data-cleaning.md](data-cleaning.md)

## 5. ไฟล์ที่สอดคล้องกับแต่ละ entity

| Entity | ไฟล์ |
|---|---|
| `ADMIN_AREA` | `data/ref/boundaries/` |
| `SURVEY_POINT` | `data/ldd/points.json` (`.geojson`, `.csv`), `state.json` |
| `ANALYSIS_SITE` / `MEASUREMENT` | `data/osd/sites_<ปี>.json`, `measurements_<ปี>.csv.gz` |
| `WOSIS_PROFILE` / `WOSIS_LAYER` | `data/wosis/profiles.json`, `layers.csv` |
| `DINDEE_SUMMARY` | `data/dindee/` (สรุปตามรหัส humdata สร้างตอน deploy) |
| `GEE_COVARIATE` | `data/gee/covariates.csv` |
| `UPDATE_RUN` / `CHANGE_ITEM` | `data/changelog.json`, `data/changes/<date>.json` |
