// ui/utils.js
export const HRS_PER_MONTH = 730;

export function fmt(n) {
  return (n == null || isNaN(n)) ? "—" : `$${Number(n).toFixed(4)}`;
}
export function monthly(ph) {
  return (ph == null || isNaN(ph)) ? null : ph * HRS_PER_MONTH;
}
export function sumSafe(a, b) {
  const na = (a == null || isNaN(a)) ? 0 : Number(a);
  const nb = (b == null || isNaN(b)) ? 0 : Number(b);
  if (a == null && b == null) return null;
  return na + nb;
}

export function fillSelect(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.text;
    el.appendChild(opt);
  }
}
export function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const match = Array.from(el.options).find(o => o.value == value);
  if (match) el.value = value;
}
export function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
export function appendToText(id, extra) {
  const el = document.getElementById(id);
  if (el) el.textContent = (el.textContent || "") + extra;
}

export function setStatus(msg, level="info") {
  const el = document.getElementById("status");
  if (!el) return;
  const err  = "var(--err,#b91c1c)";
  const warn = "var(--warn,#b45309)";
  const mut  = "var(--muted,#666)";
  el.textContent = msg;
  el.style.color = (level === "error") ? err :
                   (level === "warn")  ? warn : mut;
}

export function nearestCeil(requested, allowed) {
  const sorted = [...allowed].sort((a,b)=>a-b);
  for (const s of sorted) if (requested <= s) return s;
  return sorted.length ? sorted[sorted.length - 1] : null;
}

// Azure disk label helpers (unchanged logic)
export function sizeToAzureSku(type, size) {
  if (!isFinite(size)) return null;
  if (type === "ssd") {
    const map = {4:"E1",8:"E2",16:"E3",32:"E4",64:"E6",128:"E10",256:"E15",512:"E20",1024:"E30",2048:"E40",4096:"E50"};
    return map[size] || null;
  } else {
    const map = {32:"S4",64:"S6",128:"S10",256:"S15",512:"S20",1024:"S30",2048:"S40",4096:"S50"};
    return map[size] || null;
  }
}

// Reset all UI fields
export function resetCards() {
  document.getElementById("awsInstance").innerHTML = `<strong>Recommended Instance:</strong> …`;
  document.getElementById("azInstance").innerHTML  = `<strong>Recommended VM Size:</strong> …`;

  safeSetText("awsCpu",      "vCPU: …");
  safeSetText("awsRam",      "RAM: …");
  safeSetText("awsPrice",    "Price/hr: -");
  safeSetText("awsMonthly",  "≈ Monthly: -");

  safeSetText("azCpu",       "vCPU: …");
  safeSetText("azRam",       "RAM: …");
  safeSetText("azPrice",     "Price/hr: -");
  safeSetText("azMonthly",   "≈ Monthly: -");

  safeSetText("awsStorageSel",      "Storage: —");
  safeSetText("awsStoragePriceHr",  "—");
  safeSetText("awsStorageMonthly",  "—");
  safeSetText("awsTotalHr",         "—");
  safeSetText("awsTotalMonthly",    "—");

  safeSetText("azStorageSel",       "Storage: —");
  safeSetText("azStoragePriceHr",   "—");
  safeSetText("azStorageMonthly",   "—");
  safeSetText("azTotalHr",          "—");
  safeSetText("azTotalMonthly",     "—");
}
