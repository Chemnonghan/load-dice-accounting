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
  await Promise.all([loadPL(), loadExpenses()]);
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

checkSession();
