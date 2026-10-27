# ตั้งค่า Google Earth Engine บน GitHub Actions (ไม่ใช้ไฟล์ key)

ใช้ **Workload Identity Federation (WIF)**: Google เชื่อถือ GitHub Actions ของ repo `Navavit/thai-soil-db` สาขา `main` เท่านั้น
แต่ละรอบได้ token ชั่วคราว (หมดอายุภายใน 1 ชั่วโมง) จึงไม่มีไฟล์ key ให้หลุด

## ความปลอดภัย

| | ไฟล์ key ใน Secret | WIF |
|---|---|---|
| มีของลับเก็บไว้ถาวร | มี (ไม่หมดอายุ) | ไม่มี |
| ถ้ารั่ว | ใช้ได้จนกว่าจะลบ key | token หมดอายุเองภายใน 1 ชม. |
| ใช้นอก repo นี้ได้ไหม | ได้ ถ้าได้ไฟล์ไป | ไม่ได้ (ผูกกับ repo + สาขา main) |

สิทธิ์ของ service account: `Earth Engine Resource Viewer` + `Service Usage Consumer` เท่านั้น (อ่านข้อมูล GEE ได้อย่างเดียว)

## ขั้นตอน (ทำครั้งเดียว ประมาณ 10 นาที)

ใช้ **Cloud Shell** (ปุ่ม `>_` มุมขวาบนของ <https://console.cloud.google.com>) จะได้ไม่ต้องติดตั้ง `gcloud` ในเครื่อง
คัดลอกทีละบล็อก แก้ `PROJECT_ID` บรรทัดแรกให้เป็น project ที่ลงทะเบียน Earth Engine แล้ว

### 1. ตั้งตัวแปรและเปิด API

```bash
PROJECT_ID=your-cloud-project-id
REPO=Navavit/thai-soil-db
SA=thai-soil-db-gha

gcloud config set project $PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud services enable earthengine.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
```

### 2. สร้าง service account (สิทธิ์อ่านอย่างเดียว ไม่สร้าง key)

```bash
gcloud iam service-accounts create $SA --display-name="thai-soil-db GitHub Actions"
for ROLE in roles/earthengine.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA@$PROJECT_ID.iam.gserviceaccount.com" --role=$ROLE --condition=None
done
```

### 3. สร้าง pool และ provider ที่เชื่อถือเฉพาะ repo นี้ สาขา main

```bash
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc thai-soil-db \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"
```

### 4. อนุญาตให้ repo นี้ใช้ service account

```bash
gcloud iam service-accounts add-iam-policy-binding $SA@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

### 5. พิมพ์ค่าที่ต้องนำไปใส่ใน GitHub

```bash
echo "GCP_WIF_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/thai-soil-db"
echo "GCP_SERVICE_ACCOUNT = $SA@$PROJECT_ID.iam.gserviceaccount.com"
echo "EE_PROJECT = $PROJECT_ID"
```

### 6. ใส่ใน GitHub

repo → **Settings → Secrets and variables → Actions → แท็บ Variables → New repository variable** สร้าง 3 ตัว:

| Name | Value |
|---|---|
| `GCP_WIF_PROVIDER` | ค่าจากขั้น 5 |
| `GCP_SERVICE_ACCOUNT` | ค่าจากขั้น 5 |
| `EE_PROJECT` | project id |

ทั้ง 3 ค่าไม่ใช่ความลับ (เป็นแค่ชื่อ) จึงใส่เป็น **Variables** ได้ ไม่ต้องสร้าง Secret

### 7. ทดสอบ

**Actions → ตรวจข้อมูลใหม่ (LDD) → Run workflow** แล้วดูขั้น "ยืนยันตัวตน Google Cloud" และ "สุ่มค่าจาก Google Earth Engine" ว่าเป็นสีเขียว

## แก้ปัญหา

| อาการ | สาเหตุที่พบบ่อย |
|---|---|
| `Permission 'iam.serviceAccounts.getAccessToken' denied` | ขั้น 4 ยังไม่ได้ทำ หรือชื่อ repo ใน `REPO` ไม่ตรง (ตัวพิมพ์ใหญ่เล็กมีผล) |
| `The given credential is rejected by the attribute condition` | รัน workflow จากสาขาอื่นที่ไม่ใช่ `main` |
| `Earth Engine ... not registered` / `403` | project ยังไม่ได้ลงทะเบียน Earth Engine (<https://code.earthengine.google.com/register>) หรือรอสิทธิ์ใหม่มีผล (~5 นาที) |

## ยกเลิก

```bash
gcloud iam workload-identity-pools delete github --location=global
gcloud iam service-accounts delete $SA@$PROJECT_ID.iam.gserviceaccount.com
```
แล้วลบ Variables ทั้ง 3 ตัวใน GitHub — ขั้น GEE จะถูกข้ามอัตโนมัติ
