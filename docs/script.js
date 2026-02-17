// docs/script.js (3‑provider coordinator - AWS, Azure, GCP)

// Import helpers from utils.js
import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards, nearestCeil, sizeToAzureSku,
  HRS_PER_MONTH,
  getAwsStorageMonthlyFromCfg,
  getAzureStorageSkuAndMonthlyFromCfg,
  getGcpStorageMonthlyFromCfg
} from "./ui/utils.js";

// Only import STORAGE_CFG (we no longer use loadPricesAndMeta/API_BASE/FALLBACK_META)
import { STORAGE_CFG } from "./ui/state.js";

import { initStorageTypeTooltip, initOsTypeTooltip } from "./ui/tooltips.js";
import { findBestAws, findBestAzure, gcpFamilyMatch } from "./ui/matchers.js";

/* ============================================================
   Freshness loader: docs/data/buildInfo.json
   (published by update-all.yml)
============================================================ */
async function loadBuildInfo() {
  try {
    const r = await fetch('./data/buildInfo.json?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ============================================================
   Single-source loader: docs/data/prices.json
   - Adds cache-buster to avoid GH Pages CDN caching old JSON
   - Accepts BOTH shapes and always returns { meta, azure:[], aws:[], gcp:[], generatedAt? }

   FLAT (preferred):
     { meta:{...}, azure:[...], aws:[...], gcp:[...], generatedAt? }

   WRAPPED (tolerated):
     { azure:{meta:{...}, compute:[...]}, aws:{meta:{...}, compute:[...]}, gcp:{meta:{...}, compute:[...] , ... } }
============================================================ */
async function loadPricesFlat() {
  const url = `./data/prices.json?v=${Date.now()}`; // relative path + cache-buster
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Unable to fetch prices.json (${res.status})`);
  const j = await res.json();

  // If FLAT (preferred)
  if (Array.isArray(j.azure) && Array.isArray(j.aws) && Array.isArray(j.gcp)) {
    return {
      meta: j.meta || {},
      azure: j.azure,
      aws:   j.aws,
      gcp:   j.gcp,
      generatedAt: j.generatedAt
    };
  }

  // If WRAPPED (tolerated)
  const looksWrapped =
    j && typeof j === "object" &&
    j.azure && j.aws && j.gcp &&
    !Array.isArray(j.azure) && !Array.isArray(j.aws) && !Array.isArray(j.gcp);

  if (looksWrapped) {
    return {
      meta: j.meta || j.azure?.meta || j.aws?.meta || j.gcp?.meta || {},
      azure: Array.isArray(j.azure?.compute) ? j.azure.compute : [],
      aws:   Array.isArray(j.aws?.compute)   ? j.aws.compute   : [],
      gcp:   Array.isArray(j.gcp?.compute)   ? j.gcp.compute   : [],
      generatedAt: j.generatedAt
    };
  }

  // Unknown shape → fail clearly
  throw new Error("prices.json has an unexpected shape");
}

/* ============================================================
   3-PROVIDER FAMILY FILTERS (AWS, Azure, GCP)
============================================================ */
function showFamilyFilters() {
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  });
}

function resetFamilyFilters() {
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

/* ============================================================
   STORAGE HELPERS (delegate to utils.js)
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

  // Reset dropdowns on first compare
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

  const familyAws = document.getElementById("awsFamily")?.value || "";
  const familyAz  = document.getElementById("azFamily")?.value  || "";
  const familyGcp = document.getElementById("gcpFamily")?.value || "";

  try {
    resetCards();
    // Use the shape-tolerant loader
    const data = await loadPricesFlat();

    // >>> Footer: show freshness + row counts
    // If you're now publishing buildInfo.json from update-all.yml,
    // this will display the timestamp and counts below the status bar.
    try {
      const info = await loadBuildInfo();
      const counts = {
        az: (data.azure || []).length,
        aw: (data.aws   || []).length,
        gc: (data.gcp   || []).length
      };
      const when = info?.generatedAt || '—';
      safeSetText(
        "dataInfo",
        `Data: ${when} · Rows — Azure: ${counts.az}, AWS: ${counts.aw}, GCP: ${counts.gc}`
      );
    } catch { /* non-fatal */ }

    /* ---------- AWS ---------- */
    let awsCard;
    try {
      const a = findBestAws(data.aws || [], vcpu, ram, os, familyAws);
      awsCard = a ? {
        instance: a.instance, vcpu: a.vcpu, ram: a.ram,
        pricePerHourUSD: a.pricePerHourUSD, region: a.region
      } : null;
    } catch (e) {
      awsCard = { error: e.message };
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
      azCard = { error: e.message };
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
      gcpCard = { error: e.message };
    }

    /* ============================================================
       STORAGE LABEL RENDER
    ============================================================= */
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
       RENDER AWS
    ============================================================= */
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

    /* ============================================================
       RENDER AZURE
    ============================================================= */
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

    /* ============================================================
       RENDER GCP
    ============================================================= */
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
       STORAGE COST RENDER
    ============================================================= */
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
    ============================================================= */
    const awsTotalHr  = sumSafe(awsCard?.pricePerHourUSD,  awsStorageHr);
    const awsTotalMon = sumSafe(monthly(awsCard?.pricePerHourUSD), awsStorageMonthly);

    const azTotalHr  = sumSafe(azCard?.pricePerHourUSD,  azStorageHr);
    const azTotalMon = sumSafe(monthly(azCard?.pricePerHourUSD), azStorageMonthly);

    const gcpTotalHr  = sumSafe(gcpCard?.pricePerHourUSD, gcpStorageHr);
    const gcpTotalMon = sumSafe(monthly(gcpCard?.pricePerHourUSD), gcpStorageMonthly);

    safeSetText("awsTotalHr",      fmt(awsTotalHr));
    safeSetText("awsTotalMonthly", fmt(awsTotalMon));

    safeSetText("azTotalHr",       fmt(azTotalHr));
    safeSetText("azTotalMonthly",  fmt(azTotalMon));

    safeSetText("gcpTotalHr",      fmt(gcpTotalHr));
    safeSetText("gcpTotalMonthly", fmt(gcpTotalMon));

    /* ============================================================
       DONE
    ============================================================= */
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
document.addEventListener("DOMContentLoaded", () => {

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
