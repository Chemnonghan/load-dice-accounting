"""
Sync ข้อมูลจาก Loyverse POS API เข้า Supabase
รันโดย GitHub Actions (ดู .github/workflows/sync.yml) ตามตารางเวลาที่ตั้งไว้
หรือรันมือได้: python sync_loyverse.py

ต้องตั้ง environment variables ก่อนรัน:
  LOYVERSE_ACCESS_TOKEN     - Access Token ของ Loyverse (สิทธิ์อ่าน receipts + inventory)
  SUPABASE_URL              - เช่น https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY - service role key (ห้ามใช้ใน dashboard ฝั่ง browser เด็ดขาด)

แก้ค่าคงที่ GAME_RENTAL_CATEGORY_NAMES ด้านล่างให้ตรงกับชื่อ category
ที่ตั้งไว้ใน Loyverse สำหรับ "ค่าเช่าเกม/ชั่วโมงเล่น"
"""

import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

LOYVERSE_BASE_URL = "https://api.loyverse.com/v1.0"
LOYVERSE_ACCESS_TOKEN = os.environ.get("LOYVERSE_ACCESS_TOKEN")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# จำนวนวันย้อนหลังที่จะดึงข้อมูลทุกครั้งที่ sync (ครอบคลุมพอให้ข้อมูลที่แก้ไขย้อนหลังอัปเดตด้วย)
SYNC_LOOKBACK_DAYS = int(os.environ.get("SYNC_LOOKBACK_DAYS", "45"))

# ชื่อ category ใน Loyverse ที่ถือเป็น "ค่าเช่าเกม/ชั่วโมงเล่น" (ไม่ใช่สินค้าขาย)
# ตั้งเป็น "ค่าบริการ" ตามชื่อ category จริงที่ใช้ในร้าน
GAME_RENTAL_CATEGORY_NAMES = {"ค่าบริการ"}

REQUIRED_ENV = ["LOYVERSE_ACCESS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]


def check_env():
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print(f"ขาด environment variable: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)


def loyverse_headers():
    return {
        "Authorization": f"Bearer {LOYVERSE_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def fetch_loyverse_paginated(path, params):
    """ดึงข้อมูลจาก Loyverse API พร้อมวน cursor จนครบทุกหน้า"""
    results = []
    cursor = None
    while True:
        query = dict(params)
        if cursor:
            query["cursor"] = cursor
        resp = requests.get(f"{LOYVERSE_BASE_URL}{path}", headers=loyverse_headers(), params=query, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        key = path.strip("/")
        items = data.get(key, [])
        results.extend(items)
        cursor = data.get("cursor")
        if not cursor:
            break
        time.sleep(0.2)  # กันยิงถี่เกิน rate limit
    return results


def classify_revenue_type(category_name):
    if category_name and category_name.strip() in GAME_RENTAL_CATEGORY_NAMES:
        return "game_rental"
    return "product_sale"


def upsert_supabase(table, rows):
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    # แบ่งเป็นชุดละ 500 แถวกันสตริง URL/payload ใหญ่เกินไป
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        resp = requests.post(url, headers=supabase_headers(), json=batch, timeout=60)
        if resp.status_code >= 300:
            print(f"Supabase upsert error [{table}]: {resp.status_code} {resp.text}", file=sys.stderr)
            resp.raise_for_status()


def log_sync(status, message):
    try:
        upsert_supabase("sync_log", [{"status": status, "message": message}])
    except Exception as e:  # อย่าให้ logging เองพังจน exit code ผิด
        print(f"ไม่สามารถบันทึก sync_log ได้: {e}", file=sys.stderr)


def sync_receipts(since_iso):
    print(f"ดึง receipts ตั้งแต่ {since_iso} ...")
    receipts_raw = fetch_loyverse_paginated(
        "/receipts",
        {"created_at_min": since_iso, "limit": 250},
    )
    print(f"พบ receipts {len(receipts_raw)} รายการ")

    receipt_rows = []
    line_item_rows = []

    for r in receipts_raw:
        receipt_id = r["receipt_number"] if "id" not in r else r.get("id", r["receipt_number"])
        receipt_id = str(r.get("receipt_number") or r.get("id"))
        receipt_date = r.get("receipt_date")
        receipt_rows.append(
            {
                "id": receipt_id,
                "receipt_number": r.get("receipt_number"),
                "receipt_date": receipt_date,
                "total_money": r.get("total_money", 0),
                "total_discount": r.get("total_discount", 0),
                "total_tax": r.get("total_tax", 0),
                "cancelled": bool(r.get("cancelled_at")),
                "raw": r,
            }
        )

        for idx, li in enumerate(r.get("line_items", [])):
            category_name = li.get("category_name") or li.get("item_category") or None
            line_item_rows.append(
                {
                    "id": f"{receipt_id}-{idx}",
                    "receipt_id": receipt_id,
                    "item_id": li.get("item_id") or li.get("variant_id"),
                    "item_name": li.get("item_name") or li.get("name"),
                    "category_name": category_name,
                    "revenue_type": classify_revenue_type(category_name),
                    "quantity": li.get("quantity", 0),
                    "price": li.get("price", 0),
                    "total_money": li.get("total_money") or li.get("gross_total_money") or 0,
                    "cost": li.get("cost_total") or li.get("cost") or 0,
                    "receipt_date": receipt_date,
                }
            )

    upsert_supabase("receipts", receipt_rows)
    upsert_supabase("receipt_line_items", line_item_rows)
    return len(receipt_rows)


def sync_inventory():
    print("ดึง inventory ...")
    inventory_raw = fetch_loyverse_paginated("/inventory", {"limit": 250})
    print(f"พบ inventory {len(inventory_raw)} รายการ")

    rows = []
    for inv in inventory_raw:
        rows.append(
            {
                "item_id": inv.get("item_id") or inv.get("variant_id"),
                "variant_id": inv.get("variant_id"),
                "item_name": inv.get("item_name") or inv.get("name"),
                "in_stock": inv.get("in_stock"),
            }
        )
    upsert_supabase("inventory_levels", rows)
    return len(rows)


def main():
    check_env()
    since = datetime.now(timezone.utc) - timedelta(days=SYNC_LOOKBACK_DAYS)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    try:
        n_receipts = sync_receipts(since_iso)
        n_inventory = sync_inventory()
        log_sync("success", f"synced {n_receipts} receipts, {n_inventory} inventory rows")
        print("Sync สำเร็จ")
    except Exception as e:
        log_sync("error", str(e))
        print(f"Sync ล้มเหลว: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
