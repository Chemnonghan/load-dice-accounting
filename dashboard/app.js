const { createClient } = supabase;
const client = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginError = document.getElementById("login-error");

function thb(n) {
  const v = Number(n || 0);
  return v.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " บาท";
}

function monthLabel(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "long" });
}

function monthLabelShort(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("th-TH", { year: "2-digit", month: "short" });
}

const WEEKDAY_NAMES_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสฯ", "ศุกร์", "เสาร์"];

// เก็บ instance ของกราฟไว้ทำลายทิ้งก่อนวาดใหม่ทุกครั้งที่ reload ข้อมูล
const charts = {};

function renderChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (charts[canvasId]) {
    charts[canvasId].destroy();
  }
  charts[canvasId] = new Chart(canvas.getContext("2d"), config);
}

async function checkSession() {
  const { data } = await client.auth.getSession();
  if (data.session) {
    showApp(data.session.user);
  } else {
    showLogin();
  }
}

function showLogin() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp(user) {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.getElementById("user-email").textContent = user.email;
  loadDashboard();
}

document.getElementById("login-btn").addEventListener("click", async () => {
  loginError.classList.add("hidden");
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    loginError.textContent = "เข้าสู่ระบบไม่สำเร็จ: " + error.message;
    loginError.classList.remove("hidden");
    return;
  }
  showApp(data.user);
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await client.auth.signOut();
  showLogin();
});

async function loadDashboard() {
  await Promise.all([loadPL(), loadExpenses(), loadServiceUsage(), loadTimePatterns()]);
}

async function loadPL() {
  const { data, error } = await client
    .from("v_monthly_pl")
    .select("*")
    .order("month", { ascending: false })
    .limit(12);

  if (error) {
    console.error(error);
    return;
  }

  // ดึงรายละเอียดรายได้แยกประเภท (ขาย vs ค่าเช่าเกม) จาก view v_monthly_revenue
  const { data: revData } = await client.from("v_monthly_revenue").select("*");

  const tbody = document.querySelector("#pl-table tbody");
  tbody.innerHTML = "";

  data.forEach((row) => {
    const revForMonth = (revData || []).filter((r) => r.month === row.month);
    const productSale = revForMonth.find((r) => r.revenue_type === "product_sale");
    const gameRental = revForMonth.find((r) => r.revenue_type === "game_rental");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${monthLabel(row.month)}</td>
      <td>${thb(productSale ? productSale.revenue : 0)}</td>
      <td>${thb(gameRental ? gameRental.revenue : 0)}</td>
      <td>${thb(row.total_cogs)}</td>
      <td>${thb(row.total_expense)}</td>
      <td>${thb(row.net_income)}</td>
    `;
    tbody.appendChild(tr);
  });

  renderKPI(data[0], data[1]);
  renderTrendChart(data);
}

function renderTrendChart(monthlyRowsDesc) {
  const rows = [...monthlyRowsDesc].reverse(); // เรียงเก่า -> ใหม่ สำหรับกราฟเส้น
  renderChart("trend-chart", {
    type: "line",
    data: {
      labels: rows.map((r) => monthLabelShort(r.month)),
      datasets: [
        {
          label: "รายได้รวม",
          data: rows.map((r) => r.total_revenue),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.1)",
          tension: 0.3,
        },
        {
          label: "รายจ่ายอื่น",
          data: rows.map((r) => r.total_expense),
          borderColor: "#dc2626",
          backgroundColor: "rgba(220,38,38,0.1)",
          tension: 0.3,
        },
        {
          label: "กำไรสุทธิ",
          data: rows.map((r) => r.net_income),
          borderColor: "#15803d",
          backgroundColor: "rgba(21,128,61,0.1)",
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { ticks: { callback: (v) => v.toLocaleString("th-TH") } } },
    },
  });
}

function renderKPI(current, prior) {
  const grid = document.getElementById("kpi-grid");
  grid.innerHTML = "";
  if (!current) {
    grid.innerHTML = '<div class="kpi"><div class="label">ยังไม่มีข้อมูล</div></div>';
    return;
  }

  const items = [
    { label: "รายได้รวม", value: current.total_revenue },
    { label: "กำไรขั้นต้น", value: current.gross_profit },
    { label: "รายจ่ายอื่น", value: current.total_expense },
    { label: "กำไรสุทธิ", value: current.net_income },
  ];

  items.forEach((item) => {
    let variancePct = "";
    if (prior) {
      const priorVal = priorValueFor(item.label, prior);
      if (priorVal) {
        const pct = ((item.value - priorVal) / Math.abs(priorVal)) * 100;
        variancePct = ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% เทียบเดือนก่อน)`;
      }
    }
    const div = document.createElement("div");
    div.className = "kpi";
    div.innerHTML = `
      <div class="label">${item.label}</div>
      <div class="value ${item.value < 0 ? "neg" : "pos"}">${thb(item.value)}</div>
      <div style="font-size:11px;color:#6b7280">${variancePct}</div>
    `;
    grid.appendChild(div);
  });
}

function priorValueFor(label, prior) {
  switch (label) {
    case "รายได้รวม": return prior.total_revenue;
    case "กำไรขั้นต้น": return prior.gross_profit;
    case "รายจ่ายอื่น": return prior.total_expense;
    case "กำไรสุทธิ": return prior.net_income;
    default: return null;
  }
}

async function loadExpenses() {
  const { data, error } = await client
    .from("manual_expenses")
    .select("*")
    .order("expense_date", { ascending: false })
    .limit(20);

  if (error) {
    console.error(error);
    return;
  }

  const tbody = document.querySelector("#expense-table tbody");
  tbody.innerHTML = "";
  (data || []).forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(row.expense_date).toLocaleDateString("th-TH")}</td>
      <td>${row.category}</td>
      <td>${row.description || ""}</td>
      <td>${thb(row.amount)}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById("expense-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("expense-message");
  msg.textContent = "";

  const { data: sessionData } = await client.auth.getSession();
  const userId = sessionData.session.user.id;

  const payload = {
    expense_date: document.getElementById("exp-date").value,
    category: document.getElementById("exp-category").value,
    amount: parseFloat(document.getElementById("exp-amount").value),
    description: document.getElementById("exp-desc").value || null,
    created_by: userId,
  };

  const { error } = await client.from("manual_expenses").insert(payload);
  if (error) {
    msg.style.color = "#b91c1c";
    msg.textContent = "บันทึกไม่สำเร็จ: " + error.message;
    return;
  }

  msg.style.color = "#15803d";
  msg.textContent = "บันทึกรายจ่ายเรียบร้อย";
  e.target.reset();
  loadDashboard();
});

async function loadServiceUsage() {
  const { data, error } = await client
    .from("v_service_usage_by_item")
    .select("*")
    .order("usage_count", { ascending: false })
    .limit(10);

  if (error) {
    console.error(error);
    return;
  }

  const rows = data || [];

  renderChart("service-usage-chart", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.item_name || "(ไม่ระบุชื่อ)"),
      datasets: [
        {
          label: "จำนวนครั้งที่ใช้บริการ",
          data: rows.map((r) => r.usage_count),
          backgroundColor: "#2563eb",
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
    },
  });

  const tbody = document.querySelector("#service-usage-table tbody");
  tbody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.item_name || "(ไม่ระบุชื่อ)"}</td>
      <td>${row.usage_count}</td>
      <td>${row.total_quantity}</td>
      <td>${thb(row.total_revenue)}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadTimePatterns() {
  const [{ data: hourData, error: hourError }, { data: dowData, error: dowError }] = await Promise.all([
    client.from("v_service_usage_by_hour").select("*").order("hour_of_day", { ascending: true }),
    client.from("v_service_usage_by_weekday").select("*").order("weekday_number", { ascending: true }),
  ]);

  if (hourError) console.error(hourError);
  if (dowError) console.error(dowError);

  // เติมชั่วโมงที่ไม่มีข้อมูลให้เป็น 0 เพื่อให้กราฟแสดงครบ 0-23 ชม.
  const hourMap = new Map((hourData || []).map((r) => [r.hour_of_day, r.usage_count]));
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${h}:00`);
  const hourValues = Array.from({ length: 24 }, (_, h) => hourMap.get(h) || 0);

  renderChart("hour-usage-chart", {
    type: "bar",
    data: {
      labels: hourLabels,
      datasets: [{ label: "จำนวนครั้ง", data: hourValues, backgroundColor: "#f59e0b" }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });

  // เติมวันที่ไม่มีข้อมูลให้เป็น 0 ด้วยเช่นกัน (0 = อาทิตย์ ... 6 = เสาร์)
  const dowMap = new Map((dowData || []).map((r) => [r.weekday_number, r.usage_count]));
  const dowValues = WEEKDAY_NAMES_TH.map((_, i) => dowMap.get(i) || 0);

  renderChart("weekday-usage-chart", {
    type: "bar",
    data: {
      labels: WEEKDAY_NAMES_TH,
      datasets: [{ label: "จำนวนครั้ง", data: dowValues, backgroundColor: "#8b5cf6" }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

checkSession();
