# Load Dice — ระบบบัญชี (Loyverse → Supabase → GitHub Pages)

โครงระบบนี้สร้างตามแผนที่คุยกันไว้: ดึงยอดขาย/สต็อกจาก Loyverse เข้า Supabase อัตโนมัติทุกวันผ่าน GitHub Actions รวมกับรายจ่ายที่กรอกเอง แล้วแสดงผลเป็น dashboard ภาษาไทยบน GitHub Pages มีระบบ login กันคนนอกเข้าถึงข้อมูล

โค้ดที่ให้มาเป็น "โครงพร้อมใช้งาน" — ต้องตั้งค่าและทดสอบตามขั้นตอนด้านล่างก่อนใช้จริง เพราะไม่มีสิทธิ์เข้าบัญชี Loyverse/Supabase/GitHub ของร้านจริง จึงยังไม่ได้ทดสอบกับข้อมูลจริง

## โครงสร้างไฟล์

```
load-dice-accounting/
  supabase/schema.sql          -- SQL สร้างตาราง, view, RLS (รันครั้งเดียวใน Supabase)
  sync/sync_loyverse.py        -- สคริปต์ดึงข้อมูลจาก Loyverse เข้า Supabase
  sync/requirements.txt
  dashboard/index.html         -- หน้าเว็บ dashboard (static site)
  dashboard/app.js
  dashboard/style.css
  dashboard/config.js          -- ใส่ Supabase URL + anon key ตรงนี้
  .github/workflows/sync.yml         -- รัน sync ทุกวันอัตโนมัติ
  .github/workflows/deploy-pages.yml -- deploy dashboard ขึ้น GitHub Pages อัตโนมัติ
```

## ขั้นตอนตั้งค่า (ทำครั้งเดียว)

### 1. ตรวจสอบ category ใน Loyverse

เปิด Loyverse Back Office → Items → ตรวจสอบว่า "ค่าเช่าเกม/ชั่วโมงเล่น" อยู่ใน category ชื่อ **"ค่าบริการ"** จริงตามที่ตั้งไว้ในระบบ (ค่านี้ถูกใส่ไว้แล้วในไฟล์ `sync/sync_loyverse.py` ตัวแปร `GAME_RENTAL_CATEGORY_NAMES`) ถ้าในร้านใช้ชื่อ category อื่นหรือมีมากกว่า 1 ชื่อ ให้แก้ค่าในตัวแปรนี้ให้ตรงก่อน sync

### 2. สร้างโปรเจกต์ Supabase

1. สร้างโปรเจกต์ใหม่ที่ supabase.com
2. เข้า SQL Editor แล้ววางเนื้อหาไฟล์ `supabase/schema.sql` ทั้งหมด กด Run
3. ไปที่ Authentication → Users → เพิ่มผู้ใช้ 3 คน (เจ้าของร้านทั้ง 3 คน) ตั้ง email + password ให้แต่ละคน แล้วส่งให้เจ้าตัวไปเปลี่ยนรหัสเอง
4. ไปที่ Project Settings → API เก็บค่า 3 ตัวไว้:
   - `Project URL`
   - `anon public key`
   - `service_role key` (เก็บเป็นความลับ ห้ามใส่ในโค้ดฝั่ง browser)

### 3. เตรียม GitHub repo

1. สร้าง repo ใหม่ (public หรือ private ก็ได้ ถ้า private ต้องมี GitHub Pro ขึ้นไปเพื่อใช้ GitHub Pages)
2. อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้ขึ้น repo
3. ไปที่ Settings → Secrets and variables → Actions → New repository secret เพิ่ม 3 ตัว:
   - `LOYVERSE_ACCESS_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. ไปที่ Settings → Pages → Source เลือก "GitHub Actions"

### 4. ใส่ค่า Supabase ลงหน้าเว็บ

แก้ไฟล์ `dashboard/config.js` ใส่ `url` และ `anonKey` (จากขั้นตอนที่ 2) แล้ว commit + push ค่านี้ไม่ใช่ความลับ ปลอดภัยที่จะอยู่ในโค้ดฝั่ง browser

### 5. รัน sync ครั้งแรกด้วยมือ

ไปที่แท็บ Actions บน GitHub → เลือก workflow "Sync Loyverse to Supabase" → กด "Run workflow" เพื่อทดสอบว่าดึงข้อมูลเข้า Supabase สำเร็จ เช็คผลได้ที่ตาราง `sync_log` และ `receipts` ใน Supabase Table Editor

**ข้อควรระวัง**: ฟิลด์ข้อมูลที่สคริปต์คาดหวังจาก Loyverse API (เช่น ชื่อ field ใน response ของ receipts/line_items) อ้างอิงจากเอกสาร API ทั่วไป อาจไม่ตรงกับ response จริงทุกตัวเป๊ะ ๆ ให้เปิดดู log ของ workflow หรือรันสคริปต์ในเครื่องตัวเองครั้งแรกเพื่อ print ตัวอย่าง response แล้วปรับชื่อ field ใน `sync_loyverse.py` ให้ตรงก่อนใช้งานจริง

### 6. เปิด dashboard

หลัง deploy-pages workflow รันสำเร็จ (จะรันอัตโนมัติเมื่อ push โค้ดในโฟลเดอร์ `dashboard/`) จะได้ URL รูปแบบ `https://<username>.github.io/<repo>/` ใช้ email/password ที่สร้างไว้ในขั้นตอนที่ 2 login เข้าใช้งานได้เลย

### 7. รันคู่ขนาน 1 เดือน

ก่อนเลิกใช้วิธีทำบัญชีแบบเดิม ให้รันระบบนี้คู่ขนานไปด้วยอย่างน้อย 1 เดือน เทียบตัวเลขให้ตรงกันก่อนใช้แทนของเดิมทั้งหมด

## จุดที่ยังต้องปรับตามข้อมูลจริงของร้าน

- ชื่อ category "ค่าเช่าเกม" ใน `sync_loyverse.py`
- ชื่อ field ใน response ของ Loyverse API (ตรวจสอบตอนรัน sync ครั้งแรก)
- รอบเวลา sync ใน `.github/workflows/sync.yml` (ตอนนี้ตั้งไว้ทุกวัน 23:00 UTC)
- งบประมาณ (budget) ยังไม่มีในระบบนี้ ถ้าต้องการเทียบกับ budget ต้องเพิ่มตาราง `budgets` และแก้ view เพิ่ม
