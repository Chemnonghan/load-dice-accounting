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

// เกณฑ์ที่ถือว่า "เบี่ยงเบนเกินเกณฑ์" ต้องดูรายละเอียด (ตามแผน ±10%)
const BUDGET_VARIANCE_THRESHOLD_PCT = 10;

// ช่วงวันที่ที่เลือกดู (เดือน) — ถ้าไม่ได้ตั้งค่า จะ fallback เป็น 12 เดือนล่าสุด
const dateRange = { from: null, to: null };

// เก็บแถวข้อมูล P&L ล่าสุดที่แสดงผลอยู่ไว้ export (Excel/PDF ใช้ข้อมูลชุดเดียวกับที่เห็นบนตาราง)
let lastPLRows = [];

async function loadDashboard() {
  await Promise.all([
    loadPL(),
    loadExpenses(),
    loadServiceUsage(),
    loadTimePatterns(),
    loadBudgetVariance(),
    loadLowStockAlerts(),
  ]);
}

async function loadPL() {
  let query = client.from("v_monthly_pl").select("*").order("month", { ascending: false });
  if (dateRange.from) query = query.gte("month", `${dateRange.from}-01`);
  if (dateRange.to) query = query.lte("month", `${dateRange.to}-01`);
  if (!dateRange.from && !dateRange.to) query = query.limit(12);

  const { data, error } = await query;

  if (error) {
    console.error(error);
    return;
  }

  // ดึงรายละเอียดรายได้แยกประเภท (ขาย vs ค่าเช่าเกม) จาก view v_monthly_revenue
  const { data: revData } = await client.from("v_monthly_revenue").select("*");

  const tbody = document.querySelector("#pl-table tbody");
  tbody.innerHTML = "";
  lastPLRows = [];

  data.forEach((row) => {
    const revForMonth = (revData || []).filter((r) => r.month === row.month);
    const productSale = revForMonth.find((r) => r.revenue_type === "product_sale");
    const gameRental = revForMonth.find((r) => r.revenue_type === "game_rental");
    const productSaleRevenue = productSale ? productSale.revenue : 0;
    const gameRentalRevenue = gameRental ? gameRental.revenue : 0;

    lastPLRows.push({
      monthLabel: monthLabel(row.month),
      productSaleRevenue,
      gameRentalRevenue,
      totalCogs: row.total_cogs,
      totalExpense: row.total_expense,
      netIncome: row.net_income,
    });

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${monthLabel(row.month)}</td>
      <td>${thb(productSaleRevenue)}</td>
      <td>${thb(gameRentalRevenue)}</td>
      <td>${thb(row.total_cogs)}</td>
      <td>${thb(row.total_expense)}</td>
      <td>${thb(row.net_income)}</td>
    `;
    tbody.appendChild(tr);
  });

  renderKPI(data[0], data[1]);
  renderTrendChart(data);
}

document.getElementById("range-apply").addEventListener("click", () => {
  dateRange.from = document.getElementById("range-from").value || null;
  dateRange.to = document.getElementById("range-to").value || null;
  loadPL();
});

document.getElementById("range-reset").addEventListener("click", () => {
  document.getElementById("range-from").value = "";
  document.getElementById("range-to").value = "";
  dateRange.from = null;
  dateRange.to = null;
  loadPL();
});

document.getElementById("export-excel-btn").addEventListener("click", () => {
  if (!lastPLRows.length) return;
  const header = ["เดือน", "รายได้ขาย", "รายได้ค่าเช่าเกม", "ต้นทุนสินค้า", "รายจ่ายอื่น", "กำไรสุทธิ"];
  const rows = lastPLRows
    .slice()
    .reverse() // เก่า -> ใหม่ ให้อ่านง่ายในไฟล์ Excel
    .map((r) => [r.monthLabel, r.productSaleRevenue, r.gameRentalRevenue, r.totalCogs, r.totalExpense, r.netIncome]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "P&L รายเดือน");
  const filename = `Load-Dice-PL-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
});

document.getElementById("export-pdf-btn").addEventListener("click", () => {
  window.print();
});

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
          borderColor: "#f97316",
          backgroundColor: "rgba(249,115,22,0.12)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "รายจ่ายอื่น",
          data: rows.map((r) => r.total_expense),
          borderColor: "#dc2626",
          backgroundColor: "rgba(220,38,38,0.08)",
          tension: 0.3,
        },
        {
          label: "กำไรสุทธิ",
          data: rows.map((r) => r.net_income),
          borderColor: "#15803d",
          backgroundColor: "rgba(21,128,61,0.08)",
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
          backgroundColor: "#f97316",
          borderRadius: 6,
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
      datasets: [{ label: "จำนวนครั้ง", data: hourValues, backgroundColor: "#fb923c", borderRadius: 4 }],
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
      datasets: [{ label: "จำนวนครั้ง", data: dowValues, backgroundColor: "#c2410c", borderRadius: 4 }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

function variancePctText(pct) {
  if (pct === null || pct === undefined) return "-";
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function varianceBadge(pct, higherIsBad) {
  if (pct === null || pct === undefined) return '<span class="badge neutral">ยังไม่ตั้งงบ</span>';
  const isBad = higherIsBad ? pct > BUDGET_VARIANCE_THRESHOLD_PCT : pct < -BUDGET_VARIANCE_THRESHOLD_PCT;
  const cls = isBad ? "warn" : "ok";
  const label = isBad ? "เกินเกณฑ์" : "ปกติ";
  return `<span class="badge ${cls}">${variancePctText(pct)} · ${label}</span>`;
}

async function loadBudgetVariance() {
  const { data, error } = await client
    .from("v_budget_variance")
    .select("*")
    .order("month", { ascending: false })
    .limit(12);

  if (error) {
    console.error(error);
    return;
  }

  const tbody = document.querySelector("#budget-table tbody");
  tbody.innerHTML = "";
  (data || []).forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${monthLabel(row.month)}</td>
      <td>${thb(row.revenue_budget)}</td>
      <td>${thb(row.actual_revenue)}</td>
      <td>${varianceBadge(row.revenue_variance_pct, false)}</td>
      <td>${thb(row.expense_budget)}</td>
      <td>${thb(row.actual_expense)}</td>
      <td>${varianceBadge(row.expense_variance_pct, true)}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById("budget-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("budget-message");
  msg.textContent = "";

  const { data: sessionData } = await client.auth.getSession();
  const userId = sessionData.session.user.id;

  const monthValue = document.getElementById("budget-month").value; // "YYYY-MM"
  if (!monthValue) return;

  const payload = {
    month: `${monthValue}-01`,
    revenue_budget: parseFloat(document.getElementById("budget-revenue").value) || 0,
    expense_budget: parseFloat(document.getElementById("budget-expense").value) || 0,
    created_by: userId,
    updated_at: new Date().toISOString(),
  };

  const { error } = await client.from("budgets").upsert(payload, { onConflict: "month" });
  if (error) {
    msg.style.color = "#dc2626";
    msg.textContent = "บันทึกไม่สำเร็จ: " + error.message;
    return;
  }

  msg.style.color = "#15803d";
  msg.textContent = "บันทึกงบประมาณเรียบร้อย";
  e.target.reset();
  loadBudgetVariance();
});

async function loadLowStockAlerts() {
  const alertBox = document.getElementById("low-stock-alerts");

  const { data: lowStock, error: lowStockError } = await client
    .from("v_low_stock")
    .select("*")
    .order("in_stock", { ascending: true });

  if (lowStockError) {
    console.error(lowStockError);
    alertBox.innerHTML = "";
  } else if (!lowStock || lowStock.length === 0) {
    alertBox.innerHTML = '<div class="alert-empty">สต็อกทุกรายการที่ตั้งเกณฑ์ไว้ยังอยู่ในระดับปกติ</div>';
  } else {
    alertBox.innerHTML = lowStock
      .map(
        (row) => `
      <div class="alert-item">
        <span class="name">${row.item_name || "(ไม่ระบุชื่อ)"}</span>
        <span class="qty">เหลือ ${row.in_stock} ชิ้น (เกณฑ์ ${row.threshold})</span>
      </div>
    `
      )
      .join("");
  }

  await Promise.all([populateStockItemSelect(), loadStockWatchlist()]);
}

async function populateStockItemSelect() {
  const select = document.getElementById("stock-item-select");
  const currentValue = select.value;

  const { data, error } = await client
    .from("v_latest_inventory")
    .select("item_id, item_name")
    .order("item_name", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  select.innerHTML = '<option value="">เลือกสินค้า</option>';
  (data || [])
    .filter((r) => r.item_name)
    .forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.item_id;
      opt.textContent = r.item_name;
      opt.dataset.itemName = r.item_name;
      select.appendChild(opt);
    });

  if (currentValue) select.value = currentValue;
}

async function loadStockWatchlist() {
  const { data, error } = await client
    .from("v_stock_watchlist")
    .select("*")
    .order("item_name", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  const tbody = document.querySelector("#stock-watchlist-table tbody");
  tbody.innerHTML = "";
  (data || []).forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.item_name || "(ไม่ระบุชื่อ)"}</td>
      <td>${row.in_stock ?? "-"}</td>
      <td>${row.threshold}</td>
      <td><button type="button" class="icon-btn" data-remove-item="${row.item_id}">ลบ</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-remove-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { error: delError } = await client
        .from("stock_thresholds")
        .delete()
        .eq("item_id", btn.dataset.removeItem);
      if (delError) {
        console.error(delError);
        return;
      }
      loadLowStockAlerts();
    });
  });
}

document.getElementById("stock-threshold-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("stock-threshold-message");
  msg.textContent = "";

  const select = document.getElementById("stock-item-select");
  const itemId = select.value;
  const itemName = select.selectedOptions[0]?.dataset.itemName || null;
  const threshold = parseFloat(document.getElementById("stock-threshold-value").value);

  if (!itemId) return;

  const { data: sessionData } = await client.auth.getSession();
  const userId = sessionData.session.user.id;

  const { error } = await client.from("stock_thresholds").upsert(
    {
      item_id: itemId,
      item_name: itemName,
      threshold,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "item_id" }
  );

  if (error) {
    msg.style.color = "#dc2626";
    msg.textContent = "บันทึกไม่สำเร็จ: " + error.message;
    return;
  }

  msg.style.color = "#15803d";
  msg.textContent = "บันทึกเกณฑ์เรียบร้อย";
  e.target.reset();
  loadLowStockAlerts();
});

checkSession();
