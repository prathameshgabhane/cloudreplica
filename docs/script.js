// docs/script.js (tiny coordinator - ES module)
import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards, nearestCeil, sizeToAzureSku,
  HRS_PER_MONTH
} from "./ui/utils.js";
import { API_BASE, FALLBACK_META, STORAGE_CFG, loadPricesAndMeta } from "./ui/state.js";
import { initStorageTypeTooltip, initOsTypeTooltip } from "./ui/tooltips.js";
import { findBestAws, findBestAzure } from "./ui/matchers.js";

function showFamilyFilters() {
  const awsW = document.getElementById("awsFamilyWrap");
  const azW  = document.getElementById("azFamilyWrap");
  if (awsW) awsW.style.display = "flex";
  if (azW)  azW.style.display  = "flex";
}
function resetFamilyFilters() {
  const awsW = document.getElementById("awsFamilyWrap");
  const azW  = document.getElementById("azFamilyWrap");
  if (awsW) awsW.style.display = "none";
  if (azW)  azW.style.display  = "none";
}

// Storage resolvers (unchanged logic, but short)
function getAwsStorageMonthlyFromCfg(type, gb, awsCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || "hdd").toLowerCase();
  if (t === "ssd") return gb * Number(awsCfg?.ssd_per_gb_month ?? 0.08);
  return gb * Number(awsCfg?.hdd_st1_per_gb_month ?? 0.045);
}
function getAzureStorageSkuAndMonthlyFromCfg(type, gb, azCfg) {
  const t = (type || "hdd").toLowerCase();
  if (!isFinite(gb) || gb <= 0) return { sku: null, size: null, monthlyUSD: null };
  const ssdTbl = azCfg?.ssd_monthly || {};
  const hddTbl = azCfg?.hdd_monthly || {};
  if (t === "ssd") {
    const size = nearestCeil(gb, Object.keys(ssdTbl).map(Number));
    const monthlyUSD = size != null ? (ssdTbl[size] ?? null) : null;
    const sku = sizeToAzureSku("ssd", size);
    return { sku, size, monthlyUSD };
  } else {
    const size = nearestCeil(gb, Object.keys(hddTbl).map(Number));
    const monthlyUSD = size != null ? (hddTbl[size] ?? null) : null;
    const sku = sizeToAzureSku("hdd", size);
    return { sku, size, monthlyUSD };
  }
}

// Main compare flow (very short now)
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  if (btn) btn.disabled = true;
  setStatus("Fetching local prices…");

  if (resetFamilies) {
    const awsSel = document.getElementById("awsFamily");
    const azSel  = document.getElementById("azFamily");
    if (awsSel) awsSel.value = "";
    if (azSel)  azSel.value = "";
  }

  const os           = document.getElementById("os")?.value || "Linux";
  const vcpu         = Number(document.getElementById("cpu")?.value ?? 0);
  const ram          = Number(document.getElementById("ram")?.value ?? 0);
  const storageType  = (document.getElementById("storageType")?.value || "hdd").toLowerCase();
  const storageAmtGB = Number(document.getElementById("storageAmt")?.value ?? 0);
  const familyAws    = document.getElementById("awsFamily")?.value || "";
  const familyAz     = document.getElementById("azFamily")?.value  || "";

  try {
    resetCards();
    const data = await loadPricesAndMeta();

    // ---- AWS match
    let awsCard;
    try {
      const a = findBestAws(data.aws || [], vcpu, ram, os, familyAws);
      awsCard = a ? {
        instance: a.instance, vcpu: a.vcpu, ram: a.ram,
        pricePerHourUSD: a.pricePerHourUSD, region: a.region
      } : null;
    } catch (e) {
      awsCard = { error: e.message || String(e) };
    }

    // ---- Azure match (with family fallback + category-aware match inside)
    let azCard;
    try {
      const z = findBestAzure(data.azure || [], vcpu, ram, os, familyAz);
      azCard = z ? {
        instance: z.instance, vcpu: z.vcpu ?? vcpu, ram: z.ram ?? ram,
        pricePerHourUSD: z.pricePerHourUSD, region: z.region, os
      } : null;
    } catch (e) {
      azCard = { error: e.message || String(e) };
    }

    const selLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${selLabel}`);
    safeSetText("azStorageSel",  `Storage: ${selLabel}`);

    const awsStorageMonthly = getAwsStorageMonthlyFromCfg(storageType, storageAmtGB, STORAGE_CFG.aws);
    const awsStorageHr      = (awsStorageMonthly != null) ? awsStorageMonthly / HRS_PER_MONTH : null;

    const { sku: azDiskSku, size: azDiskGB, monthlyUSD: azStorageMonthly } =
      getAzureStorageSkuAndMonthlyFromCfg(storageType, storageAmtGB, STORAGE_CFG.azure);
    const azStorageHr = (azStorageMonthly != null) ? azStorageMonthly / HRS_PER_MONTH : null;

    // Render AWS
    if (!awsCard || awsCard.error) {
      document.getElementById("awsInstance").innerHTML =
        `<strong>Recommended Instance:</strong> Error: ${awsCard?.error ?? "No match"}`;
    } else {
      document.getElementById("awsInstance").innerHTML =
        `<strong>Recommended Instance:</strong> ${awsCard.instance} (${awsCard.region})`;
      safeSetText("awsCpu",     `vCPU: ${awsCard.vcpu}`);
      safeSetText("awsRam",     `RAM: ${awsCard.ram} GB`);
      safeSetText("awsPrice",   `Price/hr: ${fmt(awsCard.pricePerHourUSD)}`);
      safeSetText("awsMonthly", `≈ Monthly: ${fmt(monthly(awsCard.pricePerHourUSD))}`);
    }

    // Render Azure
    if (!azCard || azCard.error) {
      document.getElementById("azInstance").innerHTML =
        `<strong>Recommended VM Size:</strong> Error: ${azCard?.error ?? "No match"}`;
    } else {
      document.getElementById("azInstance").innerHTML =
        `<strong>Recommended VM Size:</strong> ${azCard.instance} (${azCard.region})`;
      safeSetText("azCpu",     `vCPU: ${azCard.vcpu}`);
      safeSetText("azRam",     `RAM: ${azCard.ram} GB`);
      safeSetText("azPrice",   `Price/hr: ${fmt(azCard.pricePerHourUSD)}`);
      safeSetText("azMonthly", `≈ Monthly: ${fmt(monthly(azCard.pricePerHourUSD))}`);
    }

    // Storage rendering
    safeSetText("awsStoragePriceHr", fmt(awsStorageHr));
    safeSetText("awsStorageMonthly", fmt(awsStorageMonthly));
    safeSetText("azStoragePriceHr",  fmt(azStorageHr));
    safeSetText("azStorageMonthly",  fmt(azStorageMonthly));
    if (azDiskSku) {
      const extra = (azDiskGB && azDiskGB !== storageAmtGB)
        ? ` (billed as ${azDiskGB} GB ${storageType.toUpperCase()}, ${azDiskSku})`
        : ` (${azDiskSku})`;
      appendToText("azStorageSel", extra);
    }

    // Totals
    const awsComputeHr     = awsCard?.pricePerHourUSD ?? null;
    const awsComputeMonth  = monthly(awsComputeHr);
    const awsTotalHr       = sumSafe(awsComputeHr, awsStorageHr);
    const awsTotalMonthly  = sumSafe(awsComputeMonth, awsStorageMonthly);

    const azComputeHr     = azCard?.pricePerHourUSD ?? null;
    const azComputeMonth  = monthly(azComputeHr);
    const azTotalHr       = sumSafe(azComputeHr, azStorageHr);
    const azTotalMonthly  = sumSafe(azComputeMonth, azStorageMonthly);

    safeSetText("awsTotalHr",      fmt(awsTotalHr));
    safeSetText("awsTotalMonthly", fmt(awsTotalMonthly));
    safeSetText("azTotalHr",       fmt(azTotalHr));
    safeSetText("azTotalMonthly",  fmt(azTotalMonthly));

    showFamilyFilters();
    setStatus("Comparison complete ✓");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    alert("Unable to read local prices. Please try again.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Expose compare() for the inline onclick handler in index.html
window.compare = compare;

// Bootstrap
document.addEventListener("DOMContentLoaded", async () => {
  // Fallback meta so UI isn't blank
  fillSelect("os",   [{ value: "Linux", text: "Linux" }, { value: "Windows", text: "Windows" }]);
  fillSelect("cpu",  [1, 2, 4, 8, 16].map(v => ({ value: v, text: v })));
  fillSelect("ram",  [1, 2, 4, 8, 16, 32].map(v => ({ value: v, text: v })));
  setSelectValue("os", "Linux"); setSelectValue("cpu", "2"); setSelectValue("ram", "4");

  // Family change = re-compare (persist selection)
  ["awsFamily", "azFamily"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => compare(false));
  });

  initStorageTypeTooltip();
  initOsTypeTooltip();

  // Try improving meta from prices.json (optional)
  try {
    const r = await fetch(API_BASE, { mode: "cors" });
    const j = r.ok ? await r.json() : {};
    const meta = j.meta;
    if (j.storage?.aws || j.storage?.azure) {
      // state.js loadPricesAndMeta will also re-sync on compare(); keeping early copy safe
    }
    if (meta) {
      const osItems = Array.isArray(meta.os)
        ? meta.os.map(x => (typeof x === "string" ? { value: x, text: x } : { value: x.value, text: x.value }))
        : [{ value: "Linux", text: "Linux" }, { value: "Windows", text: "Windows" }];

      fillSelect("os", osItems);
      fillSelect("cpu", (meta.vcpu || [1, 2, 4, 8, 16]).map(v => ({ value: v, text: v })));
      fillSelect("ram", (meta.ram  || [1, 2, 4, 8, 16, 32]).map(v => ({ value: v, text: v })));

      setSelectValue("os", "Linux");
      setSelectValue("cpu", "2");
      setSelectValue("ram", "4");
    }
  } catch {}

  // Also hook the Compare button from JS (works even if inline handler is removed)
  document.getElementById("compareBtn")?.addEventListener("click", () => compare(true));

  compare(false);
});
