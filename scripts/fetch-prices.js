// scripts/fetch-prices.js (CommonJS)
// Purpose: Build a compact prices.json with correct AWS On-Demand hourly rates,
// Azure Retail compute prices, and Managed Disk storage pricing (no creds, no backend).

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

// Returns true if a product's attributes look like standard On-Demand, Linux, shared tenancy, used capacity
function isLinuxSharedUsed(attrs) {
  const os  = String(attrs.operatingSystem || "").toLowerCase();
  const ten = String(attrs.tenancy         || "").toLowerCase();
  const pre = String(attrs.preInstalledSw  || "").toLowerCase();
  const cap = String(attrs.capacitystatus  || "").toLowerCase();
  return os === "linux" && ten === "shared" && pre === "na" && cap === "used";
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

    // Only standard On-Demand Linux, shared tenancy, used capacity
    if (!isLinuxSharedUsed(attrs)) continue;

    // OPTIONAL: filter out unwanted families to reduce size
    // if (!AWS_FAMILY_WHITELIST.test(instance)) continue;

    // Extract vCPU and RAM (GiB)
    const vcpu = Number(attrs.vcpu || 0);
    const ram  = Number(String(attrs.memory || "0 GB").split(" ")[0]);

    // Pull the correct hourly pricePerUnit.USD
    const onDemandTerms = data.terms?.OnDemand?.[sku];
    const price = pickHourlyUsd(onDemandTerms);
    if (price == null || price === 0) continue;

    rows.push({ instance, vcpu, ram, pricePerHourUSD: price, region });
  }

  // OPTIONAL: cap per family to keep file smaller
  /*
  const grouped = {};
  for (const row of rows) {
    const fam = row.instance.split(".")[0]; // e.g., m5.large -> m5
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

/**
 * Fetch Azure VM retail prices for compute.
 * Uses api-version=2023-01-01-preview and URL-encodes $filter (case-sensitive filters).
 * Note: field is 'type' (Consumption), not 'priceType'. 
 * Docs show case-sensitive filter behavior in preview version; API examples include "type": "Consumption".
 */
async function fetchAzureCompute(region = "eastus") {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and type eq 'Consumption'`;
  const base = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}&$top=200`;

  const all = [];
  let next = base;

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new Error(`Azure VM pricing (${region}) HTTP ${resp.status} – ${body?.slice(0,300) || 'no response body'}`);
    }
    const page = await resp.json();
    const items = page.Items || [];
    for (const x of items) {
      all.push({
        instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
        pricePerHourUSD: x.unitPrice ?? x.retailPrice ?? null,
        region,
        vcpu: null,
        ram: null
      });
    }
    next = page.NextPageLink || null;
  }

  // Optional fallback (without region in server filter)
  if (all.length === 0) {
    const fbFilter = `serviceName eq 'Virtual Machines' and type eq 'Consumption'`;
    let url = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(fbFilter)}&$top=200`;
    while (url) {
      const r2 = await fetch(url);
      if (!r2.ok) {
        const body = await safeText(r2);
        throw new Error(`Azure VM fallback HTTP ${r2.status} – ${body?.slice(0,300) || 'no response body'}`);
      }
      const pg = await r2.json();
      const items = (pg.Items || []).filter(it => (it.armRegionName || "").toLowerCase() === region.toLowerCase());
      for (const x of items) {
        all.push({
          instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
          pricePerHourUSD: x.unitPrice ?? x.retailPrice ?? null,
          region,
          vcpu: null,
          ram: null
        });
      }
      url = pg.NextPageLink || null;
    }
  }

  return all;
}

/**
 * Fetch Azure Managed Disk (Storage) retail prices (monthly) for Standard SSD (E*) and Standard HDD (S*).
 * Uses api-version=2023-01-01-preview and URL-encodes $filter.
 * Note: field is 'type' (Consumption), not 'priceType'.
 */
async function fetchAzureManagedDisks(region = "eastus") {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Managed Disks' and type eq 'Consumption'`;
  const base = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}&$top=200`;

  const ssd = {}; // { 4: price, 8: price, ... }
  const hdd = {}; // { 32: price, 64: price, ... }

  // SKU -> GiB maps (Standard SSD E*, Standard HDD S*)
  const SSD_MAP = { E1: 4, E2: 8, E3: 16, E4: 32, E6: 64, E10: 128, E15: 256, E20: 512 };
  const HDD_MAP = { S4: 32, S6: 64, S10: 128, S15: 256, S20: 512 };

  let next = base;
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
/**
 * Public EBS per-GB prices vary by region & volume type.
 * gp3 commonly lists at ~$0.08/GB-month in us-east-1; st1 around ~$0.045/GB-month.
 * Always validate against the official EBS pricing page for your region. 
 */
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
