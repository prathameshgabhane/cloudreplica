// scripts/fetch-prices.js (CommonJS)
// Azure PAYG (Ubuntu + Windows) by modern series only, OS-strict, deduped;
// ARM "/vmSizes" enrichment for vCPU/RAM; AWS unchanged.

const fetch = require("node-fetch");
const fs = require("fs");

/* =====================================
   CONFIG
===================================== */
const AWS_REGION   = process.env.AWS_REGION   || "us-east-1";
const AZURE_REGION = process.env.AZURE_REGION || "eastus";
const ARM_TOKEN    = process.env.ARM_TOKEN; // set by GitHub OIDC workflow

if (!ARM_TOKEN) {
  console.error("❌ ARM_TOKEN missing — GitHub OIDC workflow must export it.");
  process.exit(1);
}

/* =====================================
   HELPERS
===================================== */
// ---------- AWS helpers (unchanged) ----------
function isSharedUsed(attrs) {
  const ten = String(attrs.tenancy || "").toLowerCase();
  const pre = String(attrs.preInstalledSw || "").toLowerCase();
  const cap = String(attrs.capacitystatus || "").toLowerCase();
  return ten === "shared" && pre === "na" && cap === "used";
}
function isAwsLinux(attrs) {
  return String(attrs.operatingSystem || "").toLowerCase() === "linux" && isSharedUsed(attrs);
}
function isAwsWindows(attrs) {
  return String(attrs.operatingSystem || "").toLowerCase() === "windows" && isSharedUsed(attrs);
}
function isWantedAwsFamily(instanceType) {
  if (!instanceType) return false;
  const s = String(instanceType).toLowerCase();
  // general: m/t ; compute: c ; memory: r/x/z
  return /^[mtcrxz]/.test(s);
}
function pickHourlyUsd(onDemandTerms) {
  if (!onDemandTerms) return null;
  for (const term of Object.values(onDemandTerms)) {
    for (const dim of Object.values(term.priceDimensions || {})) {
      const unit = String(dim.unit || "").toLowerCase();
      const begin = dim.beginRange;
      const end = dim.endRange;
      const usd = Number(dim?.pricePerUnit?.USD);
      const desc = String(dim.description || "").toLowerCase();
      const isHourly = unit === "hrs" && begin === "0" && end === "Inf";
      const isBad = /reserved|upfront|dedicated host|dedicated|savings plan/i.test(desc);
      if (isHourly && !isBad && !Number.isNaN(usd)) return usd;
    }
  }
  return null;
}

// ---------- Modern Azure series allow-list ----------
/**
 * Keep only common/current series (no legacy v1/v2).
 * General  : Dv5/6/7, Dsv5/6/7, Dasv5/6/7, Dadsv5/6/7, Dpsv5/6, Bsv2/Basv2, Bpsv2 (Linux-only)
 * Compute  : Fsv2, Famsv6/7, Fadsv7, Fasv7
 * Memory   : Ev5/Esv5, Edv5, Ebsv5
 *
 * Refs:
 *  - Azure VM series overview & families (modern series)  (pricing/series page)  [turn5search26]
 *  - F family (compute-optimized), Fsv2                    [turn5search27][turn5search24]
 *  - E family (memory-optimized), Ev5/Esv5/Edv5/Ebsv5      [turn5search30][turn5search31][turn5search33]
 *  - Dv2 is previous generation (exclude)                  [turn5search35]
 */
const AZ_SERIES_ALLOW = {
  general: [
    /^standard_d(v5|v6|v7)/i,
    /^standard_ds(v5|v6|v7)/i,
    /^standard_das(v5|v6|v7)/i,
    /^standard_dads(v5|v6|v7)/i,
    /^standard_dps(v5|v6)/i,
    /^standard_b(sv2|asv2)/i,
    /^standard_bpsv2/i, // ARM -> Linux-only
  ],
  compute: [
    /^standard_fsv2/i,
    /^standard_fa(ms|mds)?v6/i,
    /^standard_fa(ms|mds)?v7/i,
    /^standard_fasv7/i,
    /^standard_fadsv7/i,
  ],
  memory: [
    /^standard_e(v5|sv5)/i,
    /^standard_edv5/i,
    /^standard_ebsv5/i,
  ],
};

function azureCategoryFromSkuName(armSkuName, productName) {
  const name = String(armSkuName || productName || '').toLowerCase();
  for (const [cat, patterns] of Object.entries(AZ_SERIES_ALLOW)) {
    if (patterns.some(rx => rx.test(name))) return cat;
  }
  return null; // not a modern/common series we track
}

// ARM indicator: “p” denotes ARM-based processor in Azure size naming (e.g., Bpsv2)  [6](https://learn.microsoft.com/en-us/azure/virtual-machines/disks-types)
function isArmSku(instance) {
  return /standard_.*p/i.test(String(instance || ''));
}

// ---------- Normalize OS ----------
function normalizeOsStrict(val) {
  const s = String(val || '').toLowerCase();
  if (s.startsWith('win')) return 'Windows';
  return 'Linux';
}

/* =====================================
   AWS COMPUTE FETCH
===================================== */
async function fetchAwsCompute(region) {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`AWS pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();
  const rows = [];
  for (const sku in data.products) {
    const prod = data.products[sku];
    if (prod.productFamily !== "Compute Instance") continue;
    const attrs = prod.attributes || {};
    const instance = attrs.instanceType;
    if (!instance) continue;
    if (!isWantedAwsFamily(instance)) continue;
    const linux = isAwsLinux(attrs);
    const win   = isAwsWindows(attrs);
    if (!linux && !win) continue;
    const vcpu = Number(attrs.vcpu || 0);
    const ram  = Number(String(attrs.memory || "0 GB").split(" ")[0]);
    const price = pickHourlyUsd(data.terms?.OnDemand?.[sku]);
    if (!price) continue;
    rows.push({
      instance,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region,
      os: linux ? "Linux" : "Windows"
    });
  }
  return rows;
}

/* =====================================
   AZURE RETAIL (PAYG) — Ubuntu & Windows
===================================== */
/**
 * We query Retail Prices API twice (Ubuntu + Windows), then keep only modern
 * series by category; enrich with vCPU/RAM via ARM /vmSizes later.
 *
 * Retail Prices API docs: Azure Retail Prices
 * We use `type eq 'Consumption'` to ensure PAYG.
 */
async function fetchAzureRetailByOs(region, os /* 'Linux' | 'Windows' */) {
  const api = "https://prices.azure.com/api/retail/prices";
  const osNeedle = os === 'Linux' ? "Ubuntu" : "Windows"; // forces OS-specific price rows
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}'
                  and type eq 'Consumption' and contains(productName, '${osNeedle}')`;
  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
  const out = [];
  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`Azure retail ${os} HTTP ${resp.status}`);
    const page = await resp.json();
    for (const x of page.Items || []) {
      const instance = x.armSkuName || x.skuName || '';
      const price = x.unitPrice ?? x.retailPrice ?? null;
      if (!price || !instance) continue;
      const category = azureCategoryFromSkuName(instance, x.productName);
      if (!category) continue; // skip legacy series
      out.push({
        instance,
        pricePerHourUSD: price,
        region,
        os,
        vcpu: null,
        ram: null,
        category
      });
    }
    next = page.NextPageLink || null;
  }
  return out;
}

async function fetchAzureComputeRetailSimplified(region) {
  // OS-strict two-pass (Ubuntu + Windows), only modern series per AZ_SERIES_ALLOW
  const linuxRows = await fetchAzureRetailByOs(region, 'Linux');
  const winRows   = await fetchAzureRetailByOs(region, 'Windows');
  const all = [...linuxRows, ...winRows];

  // Linux-only guard for ARM families (e.g., Bpsv2 Arm64) — block Windows rows  [7](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/compute-optimized/f-family)
  const filtered = all.filter(r => !(isArmSku(r.instance) && r.os === 'Windows'));

  // De-dupe per (instance|region|os): keep the lowest hourly price
  const key = r => `${r.instance.toLowerCase()}|${r.region.toLowerCase()}|${r.os}`;
  const map = new Map();
  for (const r of filtered) {
    const k = key(r);
    const cur = map.get(k);
    if (!cur || r.pricePerHourUSD < cur.pricePerHourUSD) map.set(k, r);
  }
  return Array.from(map.values());
}

/* =====================================
   AZURE VM SIZE SPECS (ARM) → vCPU / RAM
===================================== */
// Region sizes endpoint — authoritative for cores/RAM per size in region  [8](https://github.com/MicrosoftDocs/azure-compute-docs/blob/main/articles/virtual-machines/sizes/general-purpose/includes/bpsv2-series-summary.md)
async function fetchAzureVmSizes(region) {
  const url = `https://management.azure.com/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/providers/Microsoft.Compute/locations/${region}/vmSizes?api-version=2022-03-01`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ARM_TOKEN}` }
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Azure VM sizes HTTP ${resp.status} – ${t.slice(0,300)}`);
  }
  const json = await resp.json();
  const map = {};
  for (const s of json.value || []) {
    const name = s.name;
    if (!name) continue;
    map[name.toLowerCase()] = {
      vcpu: s.numberOfCores,
      ram : Math.round(s.memoryInMB / 1024)
    };
  }
  return map;
}

/* =====================================
   AZURE MANAGED DISK PRICING (SSD+HDD)
===================================== */
async function fetchAzureManagedDisks(region) {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Managed Disks' and type eq 'Consumption'`;
  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
  const ssd = {};
  const hdd = {};
  const SSD_MAP = { E1:4, E2:8, E3:16, E4:32, E6:64, E10:128, E15:256, E20:512, E30:1024, E40:2048, E50:4096 };
  const HDD_MAP = { S4:32, S6:64, S10:128, S15:256, S20:512, S30:1024, S40:2048, S50:4096 };
  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`Azure disk HTTP ${resp.status}`);
    const page = await resp.json();
    for (const it of page.Items || []) {
      const uom = String(it.unitOfMeasure || "").toLowerCase();
      if (!uom.includes("month")) continue;
      const sku = (it.armSkuName || it.skuName || "").toUpperCase();
      const price = it.unitPrice ?? it.retailPrice ?? null;
      if (!price) continue;
      const m = sku.match(/\b([ES]\d+)\b/);
      if (!m) continue;
      const code = m[1];
      if (SSD_MAP[code]) ssd[SSD_MAP[code]] = price;
      if (HDD_MAP[code]) hdd[HDD_MAP[code]] = price;
    }
    next = page.NextPageLink || null;
  }
  return { region, ssd_monthly: ssd, hdd_monthly: hdd };
}

/* =====================================
   AWS EBS (simple constants for now)
===================================== */
function getAwsEbs(region) {
  return {
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  };
}

/* =====================================
   MAIN BUILD
===================================== */
(async () => {
  try {
    console.log("Fetching AWS compute...");
    const aws = await fetchAwsCompute(AWS_REGION);

    console.log("Fetching Azure retail compute (Ubuntu + Windows; modern series)...");
    const azRetail = await fetchAzureComputeRetailSimplified(AZURE_REGION);

    console.log("Fetching Azure VM size specs...");
    const azSpecs = await fetchAzureVmSizes(AZURE_REGION);

    console.log("Merging Azure specs (vCPU/RAM)...");
    for (const vm of azRetail) {
      const key = vm.instance.toLowerCase();
      if (azSpecs[key]) {
        vm.vcpu = azSpecs[key].vcpu;
        vm.ram  = azSpecs[key].ram;
      }
    }

    console.log("Fetching Azure disk pricing...");
    const azDisks = await fetchAzureManagedDisks(AZURE_REGION);
    const awsEbs  = getAwsEbs(AWS_REGION);

    const output = {
      meta: {
        os: ["Linux", "Windows"],               // UI can bind to this
        vcpu: [1, 2, 4, 8, 16, 32],             // defaults (UI can override)
        ram:  [1, 2, 4, 8, 16, 32, 64]
      },
      aws,
      azure: azRetail,                          // OS-strict, modern-only, deduped, with category
      storage: {
        aws:   { region: AWS_REGION, ...awsEbs },
        azure: azDisks
      }
    };

    fs.writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
    console.log(`
✅ Updated data/prices.json
• AWS compute: ${aws.length}
• Azure compute (modern series): ${azRetail.length}
• Azure disk SSD sizes: ${Object.keys(azDisks.ssd_monthly).length}
• Azure disk HDD sizes: ${Object.keys(azDisks.hdd_monthly).length}
`);
  } catch (e) {
    console.error("❌ Error updating prices:", e);
    process.exit(1);
  }
})();
