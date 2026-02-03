// scripts/fetch-prices.js (CommonJS)
// Purpose: Build a compact prices.json with correct AWS On-Demand hourly rates,
// Azure Retail compute prices, and Managed Disk storage pricing (no creds, no backend),
// narrowed to main families only and tagged by OS.

const fetch = require("node-fetch");
const fs = require("fs");

/* ========================
   CONFIG (tune as needed)
   ======================== */

// Primary regions to include
const AWS_REGION   = process.env.AWS_REGION   || "us-east-1";  // e.g., "ap-south-1"
const AZURE_REGION = process.env.AZURE_REGION || "eastus";     // e.g., "centralindia"

// Optional: whitelist popular, general-purpose/compute families to reduce file size
// const AWS_FAMILY_WHITELIST = /^(t3|t3a|t4g|m5|m6g|c5|c6g)/i;
// const MAX_PER_FAMILY = 8;

/* ==============================
   Helpers for AWS price parsing
   ============================== */

// Returns true if a product's attributes look like standard On-Demand, shared tenancy, used capacity
function isSharedUsed(attrs) {
  const ten = String(attrs.tenancy         || "").toLowerCase();
  const pre = String(attrs.preInstalledSw  || "").toLowerCase();
  const cap = String(attrs.capacitystatus  || "").toLowerCase();
  return ten === "shared" && pre === "na" && cap === "used";
}

// True for AWS Linux (free Linux family) On-Demand
function isAwsLinux(attrs) {
  return String(attrs.operatingSystem || "").toLowerCase() === "linux" && isSharedUsed(attrs);
}

// True for AWS Windows Server On-Demand
function isAwsWindows(attrs) {
  return String(attrs.operatingSystem || "").toLowerCase() === "windows" && isSharedUsed(attrs);
}

// --- AWS family/category detection (m5.large -> 'm')
function awsFamilyFromInstanceType(instanceType) {
  if (!instanceType || typeof instanceType !== "string") return null;
  const m = instanceType.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Keep only General purpose (m,t), Compute optimized (c), Memory optimized (r,x,z)
function isWantedAwsFamily(instanceType) {
  const fam = awsFamilyFromInstanceType(instanceType);
  return fam === "m" || fam === "t" || fam === "c" || fam === "r" || fam === "x" || fam === "z";
}

// From a single SKU's OnDemand term set, pick the correct *hourly* instance price
function pickHourlyUsd(onDemandTerms) {
  if (!onDemandTerms) return null;
  for (const term of Object.values(onDemandTerms)) {
    for (const dim of Object.values(term.priceDimensions || {})) {
      const unit = String(dim.unit || "").toLowerCase();   // should be "hrs"
      const begin = dim.beginRange;
      const end   = dim.endRange;
      const usd   = Number(dim?.pricePerUnit?.USD);
      const desc  = String(dim.description || "").toLowerCase();

      // Must be instance-hours
      const isHourly = unit === "hrs" && begin === "0" && end === "Inf";
      // Exclude RI/Dedicated/Upfront/Host related dimensions
      const looksReservedOrHost = /reserved instance|upfront fee|dedicated host/i.test(desc);

      if (isHourly && !looksReservedOrHost && !Number.isNaN(usd)) {
        return usd;
      }
    }
  }
  return null;
}

/* ===========================
   AWS: Fetch & parse (Bulk)
   =========================== */
async function fetchAwsCompute(region = "us-east-1") {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`AWS pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();

  let rows = [];

  for (const sku in data.products) {
    const prod = data.products[sku];
    if (prod.productFamily !== "Compute Instance") continue;

    const attrs = prod.attributes || {};
    const instance = attrs.instanceType;
    if (!instance) continue;

    // NEW: main families only (general m/t, compute c, memory r/x/z)
    if (!isWantedAwsFamily(instance)) continue;

    // Keep only Linux/Windows On-Demand (shared tenancy, no preinstalled SW)
    const isLinuxRow   = isAwsLinux(attrs);
    const isWindowsRow = isAwsWindows(attrs);
    if (!isLinuxRow && !isWindowsRow) continue;

    // Extract vCPU and RAM (GiB)
    const vcpu = Number(attrs.vcpu || 0);
    const ram  = Number(String(attrs.memory || "0 GB").split(" ")[0]);

    // Pull the correct hourly pricePerUnit.USD
    const onDemandTerms = data.terms?.OnDemand?.[sku];
    const price = pickHourlyUsd(onDemandTerms);
    if (price == null || price === 0) continue;

    rows.push({
      instance,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region,
      os: isLinuxRow ? "Linux" : "Windows"
    });
  }

  // OPTIONAL: cap per family to keep file smaller
  /*
  const grouped = {};
  for (const row of rows) {
    const fam = awsFamilyFromInstanceType(row.instance);
    grouped[fam] = grouped[fam] || [];
    grouped[fam].push(row);
  }
  rows = Object.values(grouped)
    .flatMap(list => list
      .sort((a, b) =>
        (a.vcpu - b.vcpu) ||
        (a.ram - b.ram)  ||
        (a.pricePerHourUSD - b.pricePerHourUSD)
      )
      .slice(0, MAX_PER_FAMILY)
    );
  */
  return rows;
}

/* ====================================
   Azure Retail Prices API (public)
   ==================================== */

// --- Azure family/category detection from armSkuName/productName
function azureCategoryFromSkuOrProduct(armSkuName, productName) {
  const n1 = String(armSkuName || "").toLowerCase();
  const n2 = String(productName || "").toLowerCase();

  // Try from armSkuName: "Standard_D4s_v3", "Standard_F8s_v2", "Standard_E16as_v5", "Standard_M64"
  let fam = null;
  const m1 = n1.match(/standard_([a-z]+)/); // captures "d", "f", "e", "m", "b", etc.
  if (m1) fam = m1[1];
  else {
    // Fallback: productName like "Dv5-series", "Bsv2-series", "DCasv5-series Linux"
    const m2 = n2.match(/\b([a-z]+)[0-9]*-?series/);
    if (m2) fam = m2[1];
  }
  if (!fam) return null;

  const first = fam[0];
  // General purpose → D, B
  if (first === "d" || first === "b") return "general";
  // Compute optimized → F
  if (first === "f") return "compute";
  // Memory optimized → E, M
  if (first === "e" || first === "m") return "memory";

  return null;
}

/**
 * Fetch Azure VM retail prices for compute.
 * - api-version=2023-01-01-preview (case-sensitive filter values)
 * - URL-encoded $filter
 * - No $top (API uses NextPageLink/$skip for paging)
 * - Field is 'type' ('Consumption'), not 'priceType'
 * - NEW: keep only main families (D/B, F, E/M) and tag OS
 */
async function fetchAzureCompute(region = "eastus") {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and type eq 'Consumption'`;
  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;

  const all = [];
  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new Error(`Azure VM pricing (${region}) HTTP ${resp.status} – ${body?.slice(0,300) || 'no response body'}`);
    }
    const page = await resp.json();

    for (const x of (page.Items || [])) {
      const unit = x.unitPrice ?? x.retailPrice ?? null;
      if (unit == null) continue;

      // OS tag from productName
      const pName = String(x.productName || "").toLowerCase();
      const os = pName.includes("linux") ? "Linux" :
                 pName.includes("windows") ? "Windows" : "Unknown";

      // NEW: category filter from armSkuName/productName
      const cat = azureCategoryFromSkuOrProduct(x.armSkuName, x.productName);
      if (cat !== "general" && cat !== "compute" && cat !== "memory") continue;

      all.push({
        instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
        pricePerHourUSD: unit,
        region,
        os,
        vcpu: null,
        ram: null
      });
    }
    next = page.NextPageLink || null;
  }

  // Optional fallback (broaden server filter and filter region client-side)
  if (all.length === 0) {
    const fbFilter = `serviceName eq 'Virtual Machines' and type eq 'Consumption'`;
    let url = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(fbFilter)}`;
    while (url) {
      const r2 = await fetch(url);
      if (!r2.ok) {
        const body = await safeText(r2);
        throw new Error(`Azure VM fallback HTTP ${r2.status} – ${body?.slice(0,300) || 'no response body'}`);
      }
      const pg = await r2.json();
      for (const x of (pg.Items || [])) {
        if (String(x.armRegionName || "").toLowerCase() !== region.toLowerCase()) continue;
        const unit = x.unitPrice ?? x.retailPrice ?? null;
        if (unit == null) continue;

        const pName = String(x.productName || "").toLowerCase();
        const os = pName.includes("linux") ? "Linux" :
                   pName.includes("windows") ? "Windows" : "Unknown";
        const cat = azureCategoryFromSkuOrProduct(x.armSkuName, x.productName);
        if (cat !== "general" && cat !== "compute" && cat !== "memory") continue;

        all.push({
          instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
          pricePerHourUSD: unit,
          region,
          os,
          vcpu: null,
          ram: null
        });
      }
      url = pg.NextPageLink || null;
    }
  }

  return all;
}

/* ====================================
   Azure Managed Disks (Storage) pricing
   ==================================== */
async function fetchAzureManagedDisks(region = "eastus") {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Managed Disks' and type eq 'Consumption'`;
  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;

  const ssd = {}; // { 4: price, 8: price, ... }
  const hdd = {}; // { 32: price, 64: price, ... }

  // SKU -> GiB maps (Standard SSD E*, Standard HDD S*)
  const SSD_MAP = { E1: 4, E2: 8, E3: 16, E4: 32, E6: 64, E10: 128, E15: 256, E20: 512 };
  const HDD_MAP = { S4: 32, S6: 64, S10: 128, S15: 256, S20: 512 };

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new Error(`Azure Managed Disks pricing (${region}) HTTP ${resp.status} – ${body?.slice(0,300) || 'no response body'}`);
    }
    const page = await resp.json();

    for (const it of (page.Items || [])) {
      // We want monthly charges; API typically returns "1 Month" or "1/Month"
      const uom = String(it.unitOfMeasure || it.unitName || "").toLowerCase();
      const perMonth = uom.includes("month");
      if (!perMonth) continue;

      const skuRaw = (it.armSkuName || it.skuName || "").toUpperCase(); // e.g., "E10 LRS", "S6 LRS"
      const price  = it.unitPrice ?? it.retailPrice ?? null;
      if (!price || !skuRaw) continue;

      const m = skuRaw.match(/\b([ES]\d+)\b/);
      if (!m) continue;
      const code = m[1];

      if (code.startsWith("E") && SSD_MAP[code] != null) {
        ssd[SSD_MAP[code]] = price;
      } else if (code.startsWith("S") && HDD_MAP[code] != null) {
        hdd[HDD_MAP[code]] = price;
      }
    }

    next = page.NextPageLink || null;
  }

  return { region, ssd_monthly: ssd, hdd_monthly: hdd };
}

/* ===========================
   AWS EBS storage (per GB-mo)
   =========================== */
function getAwsEbsPerGbMonth(region = "us-east-1") {
  const map = {
    "us-east-1": { ssd_per_gb_month: 0.08,  hdd_st1_per_gb_month: 0.045 },
    // Add more regions here as needed:
    // "ap-south-1": { ssd_per_gb_month: 0.10, hdd_st1_per_gb_month: 0.050 },
  };
  return map[region] || map["us-east-1"];
}

/* ===========================
   Build combined prices.json
   =========================== */
(async () => {
  try {
    // Compute prices
    const awsCompute   = await fetchAwsCompute(AWS_REGION);
    const azCompute    = await fetchAzureCompute(AZURE_REGION);

    // Storage prices
    const azDisks      = await fetchAzureManagedDisks(AZURE_REGION);
    const awsEbs       = getAwsEbsPerGbMonth(AWS_REGION);

    const output = {
      meta: {
        os:   ["Linux", "Windows"],
        vcpu: [1, 2, 4, 8, 16],
        ram:  [1, 2, 4, 8, 16, 32]
      },
      aws: awsCompute,
      azure: azCompute,
      storage: {
        aws: { region: AWS_REGION, ...awsEbs },
        azure: azDisks   // { region, ssd_monthly: {...}, hdd_monthly: {...} }
      }
    };

    fs.writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
    console.log(`✅ data/prices.json updated.
    • AWS compute: ${awsCompute.length}
    • Azure compute: ${azCompute.length}
    • Azure disks (SSD sizes): ${Object.keys(azDisks.ssd_monthly).length}
    • Azure disks (HDD sizes): ${Object.keys(azDisks.hdd_monthly).length}
    • AWS EBS per-GB: gp3=${awsEbs.ssd_per_gb_month} st1=${awsEbs.hdd_st1_per_gb_month}`);
  } catch (e) {
    console.error("❌ Failed to update prices:", e);
    process.exit(1);
  }
})();

/* ========== small helper for better error logs ========== */
async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}
