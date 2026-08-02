-- ============================================================
-- Load Dice Boardgame — Accounting System schema (Supabase/Postgres)
-- รันไฟล์นี้ใน Supabase SQL editor ครั้งเดียวตอนตั้งโปรเจกต์
-- ============================================================

-- ------------------------------------------------------------
-- 1. ตารางข้อมูลดิบจาก Loyverse (เขียนได้เฉพาะ sync script ผ่าน service role key)
-- ------------------------------------------------------------

create table if not exists receipts (
  id text primary key,                  -- Loyverse receipt id
  receipt_number text,
  receipt_date timestamptz not null,
  total_money numeric not null default 0,
  total_discount numeric not null default 0,
  total_tax numeric not null default 0,
  cancelled boolean not null default false,
  raw jsonb,
  synced_at timestamptz not null default now()
);

comment on table receipts is 'บิลขายจาก Loyverse (1 แถว = 1 ใบเสร็จ)';

create table if not exists receipt_line_items (
  id text primary key,                  -- receipt_id + line index
  receipt_id text not null references receipts(id) on delete cascade,
  item_id text,
  item_name text,
  category_name text,                   -- ใช้แยก "ค่าเช่าเกม" กับสินค้าขายทั่วไป
  revenue_type text not null default 'product_sale', -- 'product_sale' | 'game_rental' (คำนวณตอน sync)
  quantity numeric not null default 0,
  price numeric not null default 0,
  total_money numeric not null default 0,
  cost numeric not null default 0,      -- ต้นทุนสินค้า (ถ้า Loyverse ส่งมาให้)
  receipt_date timestamptz not null
);

comment on table receipt_line_items is 'รายการสินค้าต่อบิล ใช้คำนวณ revenue แยกประเภทและ COGS';

create table if not exists inventory_levels (
  id bigint generated always as identity primary key,
  item_id text not null,
  variant_id text,
  item_name text,
  in_stock numeric,
  snapshot_at timestamptz not null default now()
);

comment on table inventory_levels is 'สแนปช็อตสต็อกคงเหลือ ณ เวลาที่ sync แต่ละรอบ';

create table if not exists stock_thresholds (
  item_id text primary key,
  item_name text,
  threshold numeric not null default 10,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

comment on table stock_thresholds is 'เกณฑ์สต็อกขั้นต่ำที่ตั้งเองต่อสินค้า ใช้ flag แจ้งเตือนใน v_low_stock';

create table if not exists sync_log (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  status text not null,                 -- 'success' | 'error'
  message text
);

-- ------------------------------------------------------------
-- 2. ตารางที่ผู้ใช้กรอกเอง (manual expenses)
-- ------------------------------------------------------------

create table if not exists manual_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  category text not null,               -- 'ค่าเช่าร้าน' | 'เงินเดือนพนักงาน' | 'ซื้อบอร์ดเกมใหม่' | 'ค่าน้ำค่าไฟ' | 'อื่นๆ'
  description text,
  amount numeric not null check (amount >= 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table manual_expenses is 'รายจ่ายที่ไม่ได้อยู่ใน Loyverse POS กรอกโดยผู้ใช้ที่ login แล้ว';

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  month date not null unique,           -- เก็บเป็นวันที่ 1 ของเดือนเสมอ เช่น 2026-08-01
  revenue_budget numeric not null default 0,
  expense_budget numeric not null default 0,
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

comment on table budgets is 'เป้ารายได้/รายจ่ายที่ตั้งไว้รายเดือน ใช้เทียบกับตัวเลขจริงใน v_budget_variance';

-- ------------------------------------------------------------
-- 3. Views สรุปรายเดือนสำหรับ dashboard
-- ------------------------------------------------------------

create or replace view v_monthly_revenue as
select
  date_trunc('month', receipt_date)::date as month,
  revenue_type,
  sum(total_money) as revenue,
  sum(cost) as cost
from receipt_line_items
group by 1, 2;

create or replace view v_monthly_expense as
select
  date_trunc('month', expense_date)::date as month,
  category,
  sum(amount) as amount
from manual_expenses
group by 1, 2;

create or replace view v_monthly_pl as
with rev as (
  select month, sum(revenue) as total_revenue, sum(cost) as total_cogs
  from v_monthly_revenue
  group by 1
),
exp as (
  select month, sum(amount) as total_expense
  from v_monthly_expense
  group by 1
)
select
  coalesce(rev.month, exp.month) as month,
  coalesce(rev.total_revenue, 0) as total_revenue,
  coalesce(rev.total_cogs, 0) as total_cogs,
  coalesce(rev.total_revenue, 0) - coalesce(rev.total_cogs, 0) as gross_profit,
  coalesce(exp.total_expense, 0) as total_expense,
  (coalesce(rev.total_revenue, 0) - coalesce(rev.total_cogs, 0)) - coalesce(exp.total_expense, 0) as net_income
from rev
full outer join exp on rev.month = exp.month
order by 1 desc;

-- บริการ (ค่าเช่าเกม/ชั่วโมงเล่น) ที่ถูกใช้บ่อยที่สุด เรียงตามจำนวนครั้งที่ขาย
create or replace view v_service_usage_by_item as
select
  item_name,
  count(*) as usage_count,
  sum(quantity) as total_quantity,
  sum(total_money) as total_revenue
from receipt_line_items
where revenue_type = 'game_rental'
group by item_name
order by usage_count desc;

-- ช่วงเวลา (ชั่วโมงของวัน) ที่มีการใช้บริการบ่อยที่สุด (0-23, เวลาไทย UTC+7)
create or replace view v_service_usage_by_hour as
select
  extract(hour from receipt_date at time zone 'Asia/Bangkok')::int as hour_of_day,
  count(*) as usage_count
from receipt_line_items
where revenue_type = 'game_rental'
group by 1
order by 1;

-- วันในสัปดาห์ที่มีการใช้บริการบ่อยที่สุด (0 = อาทิตย์ ... 6 = เสาร์, เวลาไทย)
create or replace view v_service_usage_by_weekday as
select
  extract(dow from receipt_date at time zone 'Asia/Bangkok')::int as weekday_number,
  count(*) as usage_count
from receipt_line_items
where revenue_type = 'game_rental'
group by 1
order by 1;

-- เทียบงบประมาณที่ตั้งไว้กับตัวเลขจริงรายเดือน (revenue_variance_pct/expense_variance_pct
-- เป็นบวก = รายได้เกินเป้า/รายจ่ายเกินงบ, ลบ = รายได้ต่ำกว่าเป้า/รายจ่ายต่ำกว่างบ)
create or replace view v_budget_variance as
select
  coalesce(pl.month, b.month) as month,
  b.revenue_budget,
  coalesce(pl.total_revenue, 0) as actual_revenue,
  case when b.revenue_budget > 0
    then round((coalesce(pl.total_revenue, 0) - b.revenue_budget) / b.revenue_budget * 100, 1)
  end as revenue_variance_pct,
  b.expense_budget,
  coalesce(pl.total_expense, 0) as actual_expense,
  case when b.expense_budget > 0
    then round((coalesce(pl.total_expense, 0) - b.expense_budget) / b.expense_budget * 100, 1)
  end as expense_variance_pct
from budgets b
full outer join v_monthly_pl pl on pl.month = b.month
order by month desc;

-- สต็อกล่าสุดของแต่ละสินค้า (เอาแถวล่าสุดต่อ item_id จากทุกสแนปช็อตที่ sync มา)
create or replace view v_latest_inventory as
select distinct on (item_id)
  item_id,
  item_name,
  in_stock,
  snapshot_at
from inventory_levels
where item_id is not null
order by item_id, snapshot_at desc;

-- รายการเกณฑ์สต็อกที่ตั้งไว้ทั้งหมด พร้อมสต็อกปัจจุบัน (ใช้แสดงหน้าจัดการเกณฑ์)
create or replace view v_stock_watchlist as
select
  st.item_id,
  coalesce(li.item_name, st.item_name) as item_name,
  li.in_stock,
  st.threshold
from stock_thresholds st
left join v_latest_inventory li on li.item_id = st.item_id
order by item_name;

-- สินค้าที่สต็อกปัจจุบันต่ำกว่าหรือเท่ากับเกณฑ์ที่ตั้งไว้ ใช้แสดงเป็นการ์ดแจ้งเตือนบน dashboard
create or replace view v_low_stock as
select item_id, item_name, in_stock, threshold
from v_stock_watchlist
where in_stock is not null and in_stock <= threshold
order by in_stock asc;

-- ------------------------------------------------------------
-- 4. Row Level Security — เฉพาะผู้ที่ login (authenticated) เท่านั้นถึงอ่านได้
--    การเขียนตาราง receipts / receipt_line_items / inventory_levels ทำผ่าน
--    sync script ที่ใช้ service role key เท่านั้น (service role ข้าม RLS โดยอัตโนมัติ)
-- ------------------------------------------------------------

alter table receipts enable row level security;
alter table receipt_line_items enable row level security;
alter table inventory_levels enable row level security;
alter table manual_expenses enable row level security;
alter table sync_log enable row level security;
alter table budgets enable row level security;
alter table stock_thresholds enable row level security;

drop policy if exists "authenticated can read receipts" on receipts;
create policy "authenticated can read receipts"
  on receipts for select
  to authenticated
  using (true);

drop policy if exists "authenticated can read receipt_line_items" on receipt_line_items;
create policy "authenticated can read receipt_line_items"
  on receipt_line_items for select
  to authenticated
  using (true);

drop policy if exists "authenticated can read inventory_levels" on inventory_levels;
create policy "authenticated can read inventory_levels"
  on inventory_levels for select
  to authenticated
  using (true);

drop policy if exists "authenticated can read sync_log" on sync_log;
create policy "authenticated can read sync_log"
  on sync_log for select
  to authenticated
  using (true);

drop policy if exists "authenticated can read manual_expenses" on manual_expenses;
create policy "authenticated can read manual_expenses"
  on manual_expenses for select
  to authenticated
  using (true);

drop policy if exists "authenticated can insert manual_expenses" on manual_expenses;
create policy "authenticated can insert manual_expenses"
  on manual_expenses for insert
  to authenticated
  with check (auth.uid() = created_by);

drop policy if exists "authenticated can update own manual_expenses" on manual_expenses;
create policy "authenticated can update own manual_expenses"
  on manual_expenses for update
  to authenticated
  using (auth.uid() = created_by);

drop policy if exists "authenticated can delete own manual_expenses" on manual_expenses;
create policy "authenticated can delete own manual_expenses"
  on manual_expenses for delete
  to authenticated
  using (auth.uid() = created_by);

drop policy if exists "authenticated can read budgets" on budgets;
create policy "authenticated can read budgets"
  on budgets for select
  to authenticated
  using (true);

drop policy if exists "authenticated can insert budgets" on budgets;
create policy "authenticated can insert budgets"
  on budgets for insert
  to authenticated
  with check (true);

drop policy if exists "authenticated can update budgets" on budgets;
create policy "authenticated can update budgets"
  on budgets for update
  to authenticated
  using (true);

-- budgets เปิดให้เจ้าของร้านทั้ง 3 คนแก้ไขงบของกันและกันได้ (ไม่ผูกกับ created_by)
-- เพราะเป็นข้อมูลวางแผนร่วมกัน ต่างจาก manual_expenses ที่ผูกกับผู้กรอกแต่ละคน

drop policy if exists "authenticated can read stock_thresholds" on stock_thresholds;
create policy "authenticated can read stock_thresholds"
  on stock_thresholds for select
  to authenticated
  using (true);

drop policy if exists "authenticated can insert stock_thresholds" on stock_thresholds;
create policy "authenticated can insert stock_thresholds"
  on stock_thresholds for insert
  to authenticated
  with check (true);

drop policy if exists "authenticated can update stock_thresholds" on stock_thresholds;
create policy "authenticated can update stock_thresholds"
  on stock_thresholds for update
  to authenticated
  using (true);

drop policy if exists "authenticated can delete stock_thresholds" on stock_thresholds;
create policy "authenticated can delete stock_thresholds"
  on stock_thresholds for delete
  to authenticated
  using (true);

-- หมายเหตุ: views (v_monthly_revenue, v_monthly_expense, v_monthly_pl) จะยึด RLS
-- ของตารางต้นทางตามค่า default ของ Postgres (security_invoker) — ถ้า Supabase
-- เวอร์ชันที่ใช้ยังไม่ default เป็นแบบนี้ ให้รันคำสั่งเพิ่มเติม:
-- alter view v_monthly_revenue set (security_invoker = true);
-- alter view v_monthly_expense set (security_invoker = true);
-- alter view v_monthly_pl set (security_invoker = true);
