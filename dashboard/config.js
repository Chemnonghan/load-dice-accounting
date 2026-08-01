// ค่านี้ปลอดภัยที่จะเปิดเผยในโค้ดฝั่ง browser ได้ (ไม่ใช่ความลับ)
// ความปลอดภัยจริงอยู่ที่ Row Level Security บน Supabase (ดู supabase/schema.sql)
// แก้ 2 ค่านี้ให้ตรงกับโปรเจกต์ Supabase ของร้าน (Project Settings > API)
window.SUPABASE_CONFIG = {
  url: "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "YOUR-SUPABASE-ANON-KEY",
};
