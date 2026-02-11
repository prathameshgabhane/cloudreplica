// docs/script.js (3‑provider coordinator - AWS, Azure, GCP)
import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards, nearestCeil, sizeToAzureSku,
  HRS_PER_MONTH, getGcpStorageMonthlyFromCfg
} from "./ui/utils.js";

import { API_BASE, FALLBACK_META, STORAGE_CFG, loadPricesAndMeta } from "./ui/state.js";
import { initStorageTypeTooltip, initOsTypeTooltip } from "./ui/tooltips.js";
import { findBestAws, findBestAzure, gcpFamilyMatch } from "./ui/matchers.js";

/* ============================================================
   3-PROVIDER FAMILY FILTERS (AWS, Azure, GCP)
   (GCP panel will be added later)
   ============================================================ */
function showFamilyFilters() {
  const awsW = document.getElementById("awsFamilyWrap");
  const azW  = document.getElementById("azFamilyWrap");
  const gcpW = document.getElementById("gcpFamilyWrap");
  if (awsW) awsW.style.display = "flex";
  if (azW)  azW.style.display  = "flex";
  if (gcpW) gcpW.style.display = "flex";
}
function resetFamilyFilters() {
  const awsW = document.getElementById("awsFamilyWrap");
  const azW  = document.getElementById("azFamilyWrap");
  const gcpW = document.getElementById("gcpFamilyWrap");
  if (awsW) awsW.style.display = "none";
  if (azW)  azW.style.display  = "none";
  if (gcpW) gcpW.style.display = "none";
}

/* ============================================================
   STORAGE HELPERS
   ============================================================ */
function getAwsStorageMonthly(type, gb) {
  return getAwsStorageMonthlyFromCfg(type, gb, STORAGE_CFG.aws);
}

function getAzureStorage(type, gb) {
  return getAzureStorageSkuAndMonthlyFromCfg(type, gb, STORAGE_CFG.azure);
}

function getGcpStorageMonthly(type, gb) {
  return getGcpStorageMonthlyFromCfg(type, gb, STORAGE_CFG.gcp);
}

/* ============================================================
   findBestGcp() — implemented similar to AWS/Azure logic
   ============================================================ */
function findBestGcp(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("GCP price list is empty");

  const wantOs = String(os || "").toLowerCase();

  let filtered = list.filter(x =>
    x &&
    isFinite(x.vcpu) &&
    isFinite(x.ram) &&
    isFinite(x.pricePerHourUSD) &&
    (!wantOs || x.os.toLowerCase() === wantOs) &&
    gcpFamilyMatch(x, family)
  );

  if (filtered.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No GCP entries for OS=${os || "any"}${fLabel}`);
  }

  let best = null, bestScore = Infinity;
  for (const x of filtered) {
    const score = Math.abs(x.vcpu - vcpu) + Math.abs(x.ram - ram);
    const tieBreaker = x.pricePerHourUSD;
    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x;
      bestScore = score;
    }
  }
  return best;
}

/* ============================================================
   MAIN compare() — AWS + Azure + GCP
   ============================================================ */
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  if (btn) btn.disabled = true;
  setStatus("Fetching local prices…");

  if (resetFamilies) {
    ["awsFamily", "azFamily", "gcpFamily"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  }

  const os           = document.getElementById("os")?.value || "Linux";
  const vcpu         = Number(document.getElementById("cpu")?.value ?? 0);
  const ram          = Number(document.getElementById("ram")?.value ?? 0);
  const storageType  = (document.getElementById("storageType")?.value || "hdd").toLowerCase();
  const storageAmtGB = Number(document.getElementById("storageAmt")?.value ?? 0);
  const familyAws    = document.getElementById("awsFamily")?.value || "";
  const familyAz     = document.getElementById("azFamily")?.value  || "";
  const familyGcp    = document.getElementById("gcpFamily")?.value || "";

  try {
    resetCards();
    const data = await loadPricesAndMeta();

    /* ---------- AWS ---------- */
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

    /* ---------- Azure ---------- */
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

    /* ---------- GCP ---------- */
    let gcpCard;
    try {
      const g = findBestGcp(data.gcp || [], vcpu, ram, os, familyGcp);
      gcpCard = g ? {
        instance: g.instance, vcpu: g.vcpu, ram: g.ram,
        pricePerHourUSD: g.pricePerHourUSD, region: g.region
      } : null;
    } catch (e) {
      gcpCard = { error: e.message || String(e) };
    }

    /* ============================================================
       STORAGE DISPLAY
       ============================================================ */
    const selLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${selLabel}`);
    safeSetText("azStorageSel",  `Storage: ${selLabel}`);
    safeSetText("gcpStorageSel", `Storage: ${selLabel}`);

    /* AWS Storage */
    const awsStorageMonthly = getAwsStorageMonthly(storageType, storageAmtGB);
    const awsStorageHr      = awsStorageMonthly != null ? awsStorageMonthly / HRS_PER_MONTH : null;

    /* Azure Storage */
    const { sku: azDiskSku, size: azDiskGB, monthlyUSD: azStorageMonthly } =
      getAzureStorage(storageType, storageAmtGB);
    const azStorageHr = azStorageMonthly != null ? azStorageMonthly / HRS_PER_MONTH : null;

    /* GCP Storage */
    const gcpStorageMonthly = getGcpStorageMonthly(storageType, storageAmtGB);
    const gcpStorageHr      = gcpStorageMonthly != null ? gcpStorageMonthly / HRS_PER_MONTH : null;

    /* ============================================================
       RENDER PROVIDERS
       ============================================================ */

    /* ---- AWS ---- */
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

    /* ---- Azure ---- */
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

    /* ---- GCP ---- */
    if (!gcpCard || gcpCard.error) {
      document.getElementById("gcpInstance").innerHTML =
        `<strong>Recommended Machine:</strong> Error: ${gcpCard?.error ?? "No match"}`;
    } else {
      document.getElementById("gcpInstance").innerHTML =
        `<strong>Recommended Machine:</strong> ${gcpCard.instance} (${gcpCard.region})`;
      safeSetText("gcpCpu",     `vCPU: ${gcpCard.vcpu}`);
      safeSetText("gcpRam",     `RAM: ${gcpCard.ram} GB`);
      safeSetText("gcpPrice",   `Price/hr: ${fmt(gcpCard.pricePerHourUSD)}`);
      safeSetText("gcpMonthly", `≈ Monthly: ${fmt(monthly(gcpCard.pricePerHourUSD))}`);
    }

    /* ============================================================
       RENDER STORAGE COSTS
       ============================================================ */
    safeSetText("awsStoragePriceHr", fmt(awsStorageHr));
    safeSetText("awsStorageMonthly", fmt(awsStorageMonthly));

    safeSetText("azStoragePriceHr", fmt(azStorageHr));
    safeSetText("azStorageMonthly", fmt(azStorageMonthly));

    safeSetText("gcpStoragePriceHr", fmt(gcpStorageHr));
    safeSetText("gcpStorageMonthly", fmt(gcpStorageMonthly));

    if (azDiskSku) {
      const extra = (azDiskGB && azDiskGB !== storageAmtGB)
        ? ` (billed as ${azDiskGB} GB ${storageType.toUpperCase()}, ${azDiskSku})`
        : ` (${azDiskSku})`;
      appendToText("azStorageSel", extra);
    }

    /* ============================================================
       TOTAL COSTS
       ============================================================ */
    const awsComputeHr    = awsCard?.pricePerHourUSD ?? null;
    const awsComputeMonth = monthly(awsComputeHr);
    const awsTotalHr      = sumSafe(awsComputeHr, awsStorageHr);
    const awsTotalMonth   = sumSafe(awsComputeMonth, awsStorageMonthly);

    const azComputeHr    = azCard?.pricePerHourUSD ?? null;
    const azComputeMonth = monthly(azComputeHr);
    const azTotalHr      = sumSafe(azComputeHr, azStorageHr);
    const azTotalMonth   = sumSafe(azComputeMonth, azStorageMonthly);

    const gcpComputeHr    = gcpCard?.pricePerHourUSD ?? null;
    const gcpComputeMonth = monthly(gcpComputeHr);
    const gcpTotalHr      = sumSafe(gcpComputeHr, gcpStorageHr);
    const gcpTotalMonth   = sumSafe(gcpComputeMonth, gcpStorageMonthly);

    safeSetText("awsTotalHr",      fmt(awsTotalHr));
    safeSetText("awsTotalMonthly", fmt(awsTotalMonth));

    safeSetText("azTotalHr",       fmt(azTotalHr));
    safeSetText("azTotalMonthly",  fmt(azTotalMonth));

    safeSetText("gcpTotalHr",      fmt(gcpTotalHr));
    safeSetText("gcpTotalMonthly", fmt(gcpTotalMonth));

    /* ============================================================
       DONE
       ============================================================ */
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

window.compare = compare;

/* ============================================================
   BOOTSTRAP
   ============================================================ */
document.addEventListener("DOMContentLoaded", async () => {

  fillSelect("os",   [{ value: "Linux", text: "Linux" }, { value: "Windows", text: "Windows" }]);
  fillSelect("cpu",  [1, 2, 4, 8, 16].map(v => ({ value: v, text: v })));
  fillSelect("ram",  [1, 2, 4, 8, 16, 32].map(v => ({ value: v, text: v })));

  setSelectValue("os", "Linux");
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");

  ["awsFamily", "azFamily", "gcpFamily"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => compare(false));
  });

  initStorageTypeTooltip();
  initOsTypeTooltip();

  compare(false);
});
