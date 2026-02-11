// docs/ui/utils.js
export const HRS_PER_MONTH = 730;

/* ---------- Formatting & math helpers ---------- */
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

/* ---------- DOM helpers ---------- */
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

export function setStatus(msg, level = "info") {
  const el = document.getElementById("status");
  if (!el) return;
  const err  = "var(--err,#b91c1c)";
  const warn = "var(--warn,#b45309)";
  const mut  = "var(--muted,#666)";
  el.textContent = msg;
  el.style.color = (level === "error") ? err :
                   (level === "warn")  ? warn : mut;
}

/* ---------- Numeric helpers ---------- */
export function nearestCeil(requested, allowed) {
  const sorted = [...allowed].sort((a, b) => a - b);
  for (const s of sorted) if (requested <= s) return s;
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/* ---------- Azure disk label helpers ---------- */
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

/* ---------- Storage price resolvers ---------- */
/**
 * AWS: simple per-GB × amount table (gp3 for SSD, st1 for HDD).
 * Returns monthly USD or null.
 */
export function getAwsStorageMonthlyFromCfg(type, gb, awsCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || "hdd").toLowerCase();
  if (t === "ssd") {
    return gb * Number(awsCfg?.ssd_per_gb_month ?? 0.08);
  }
  return gb * Number(awsCfg?.hdd_st1_per_gb_month ?? 0.045);
}

/**
 * Azure: using monthly lookup tables.
 */
export function getAzureStorageSkuAndMonthlyFromCfg(type, gb, azCfg) {
  const t = (type || "hdd").toLowerCase();
  if (!isFinite(gb) || gb <= 0)
    return { sku: null, size: null, monthlyUSD: null, adjusted: false };

  const ssdTbl = azCfg?.ssd_monthly || {};
  const hddTbl = azCfg?.hdd_monthly || {};

  if (t === "ssd") {
    const size = nearestCeil(gb, Object.keys(ssdTbl).map(Number));
    const monthlyUSD = size != null ? (ssdTbl[size] ?? null) : null;
    const sku = sizeToAzureSku("ssd", size);
    return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
  }

  // HDD branch
  const allowed = Object.keys(hddTbl).map(Number);
  let size = nearestCeil(gb, allowed);
  if (size == null && allowed.length) size = allowed.sort((a, b) => a - b)[0];
  if (size != null && size < 32) size = 32;

  const monthlyUSD = size != null ? (hddTbl[size] ?? null) : null;
  const sku = sizeToAzureSku("hdd", size);
  return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
}

/* ---------- GCP storage pricing (NEW) ---------- */
/**
 * GCP PD-SSD and PD-Standard:
 * Simple per-GB rate, same as AWS model.
 */
export function getGcpStorageMonthlyFromCfg(type, gb, gcpCfg) {
  if (!isFinite(gb) || gb <= 0) return null;

  const t = (type || "hdd").toLowerCase();

  if (t === "ssd") {
    return gb * Number(gcpCfg?.ssd_per_gb_month ?? 0.17);  // PD-SSD
  }

  // HDD (PD-Standard)
  return gb * Number(gcpCfg?.hdd_per_gb_month ?? 0.04);
}

/* ---------- Reset all UI fields ---------- */
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
