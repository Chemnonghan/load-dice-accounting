// ค่านี้ปลอดภัยที่จะเปิดเผยในโค้ดฝั่ง browser ได้ (ไม่ใช่ความลับ)
// ความปลอดภัยจริงอยู่ที่ Row Level Security บน Supabase (ดู supabase/schema.sql)
// แก้ 2 ค่านี้ให้ตรงกับโปรเจกต์ Supabase ของร้าน (Project Settings > API)
window.SUPABASE_CONFIG = {
  url: "https://xwugnomzfggwyfhtjdnh.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3dWdub216Zmdnd3lmaHRqZG5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTE4MzIsImV4cCI6MjEwMTE2NzgzMn0.Mmcx8zGMIpbvIjvowRy4QQOY40saOQHbp9dMAxuaizU",
};
