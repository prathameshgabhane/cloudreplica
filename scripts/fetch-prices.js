// scripts/fetch-prices.js — CommonJS + Node18 native fetch
// Features:
// - AWS de-duplication (cheapest per instance-OS-region)
// - Azure de-duplication (cheapest per instance-OS-region)
// - Best-effort Azure enrichment (vmSizes)
// - FAILOVER: if AWS or Azure arrays are empty, DO NOT overwrite data/prices.json
// - Atomic write: write to data/prices.tmp.json then rename to data/prices.json

const fs = require("fs");
const path = require("path");

// Require Node 18+ (global fetch)
if (typeof fetch !== "function") {
  throw new Error("This script requires Node 18+ (global fetch).");
}

// ---------------------------
// CONFIG
// ---------------------------
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AZURE_REGION = process.env.AZURE_REGION || "eastus";

// AWS families to keep
const EC2_PREFIXES = ["m", "c", "r", "t", "x", "i", "z", "h"];

// Modern Azure series
const ALLOWED_AZURE_SERIES = [
  "D", "DS", "Dsv3", "Dsv4", "Dv5", "Dv6",
  "E", "Ev5", "Ev6",
  "Fsv2",
  "Lsv3",
  "Dplsv5"
];

// ---------------------------
// FETCH AWS PRICES (CHEAPEST)
// ---------------------------
async function fetchAWSPrices() {
  console.log(`[AWS] Fetching EC2 On-Demand prices for ${AWS_REGION}…`);

  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${AWS_REGION}/index.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[AWS] Pricing API HTTP ${res.status}`);
  const json = await res.json();

  const products = json.products || {};
  const terms = (json.terms && json.terms.OnDemand) || {};

  // Keep only the cheapest per (instance, OS, region)
  const unique = {};

  for (const sku in products) {
    const prod = products[sku];
    if (!prod || prod.productFamily !== "Compute Instance") continue;

    const a = prod.attributes || {};
    const instance = a.instanceType;
    if (!instance) continue;

    // family filter
    if (!EC2_PREFIXES.includes(instance[0])) continue;

    // only Linux & Windows
    const os = a.operatingSystem;
    if (!["Linux", "Windows"].includes(os)) continue;

    // shared tenancy only
    if (a.tenancy !== "Shared") continue;

    // capacity status accepted
    if (!["Used", "Normal"].includes(a.capacitystatus)) continue;

    // On-Demand term
    const skuTerms = terms[sku];
    if (!skuTerms) continue;
    const termKey = Object.keys(skuTerms)[0];
    if (!termKey) continue;
    const priceDimensions = skuTerms[termKey].priceDimensions;
    if (!priceDimensions) continue;
    const priceKey = Object.keys(priceDimensions)[0];
    if (!priceKey) continue;

    const dim = priceDimensions[priceKey];
    const price = Number(dim?.pricePerUnit?.USD);
    if (!Number.isFinite(price) || price <= 0) continue;

    // specs
    const vcpu = a.vcpu ? parseInt(a.vcpu, 10) : undefined;
    const ram = a.memory ? parseFloat(String(a.memory).replace(/ GiB/i, "")) : undefined;

    const key = `${instance}-${os}-${AWS_REGION}`;
    if (!unique[key] || price < unique[key].pricePerHourUSD) {
      unique[key] = {
        instance,
        vcpu,
        ram,
        pricePerHourUSD: price,
        region: AWS_REGION,
        os
      };
    }
  }

  const out = Object.values(unique);
  console.log(`[AWS] Final unique rows: ${out.length}`);
  return out;
}

// ---------------------------
// FETCH AZURE PRICES (CHEAPEST)
// ---------------------------
async function fetchAzurePrices() {
  console.log(`[Azure] Fetching Retail prices for region: ${AZURE_REGION}…`);

  // Base retail prices (Linux + Windows)
  // We treat empty result as a failure for failover purposes.
  const baseUrl =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=armRegionName eq '${AZURE_REGION}' and type eq 'Consumption'` +
    ` and (endswith(skuName,'Linux') or endswith(skuName,'Windows'))`;

  const items = [];
  let next = baseUrl;

  // Defensive pagination with a page cap to avoid infinite loops
  let pages = 0;
  const MAX_PAGES = 200;

  while (next && pages < MAX_PAGES) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`[Azure] Retail API HTTP ${resp.status}`);
    const page = await resp.json();
    items.push(...(page.Items || []));
    next = page.NextPageLink || null;
    pages++;
  }

  // If Retail returned nothing, let caller decide failover
  if (!items.length) {
    console.warn("[Azure] Retail API returned 0 items.");
    return [];
  }

  // Keep cheapest per (instance, OS, region)
  const uniq = {};
  for (const it of items) {
    const skuName = it?.skuName || "";
    const instance = skuName.split(" ")[0]; // e.g., Standard_D4s_v5
    if (!instance) continue;

    // Only allow modern series
    if (!ALLOWED_AZURE_SERIES.some(s => instance.startsWith(s))) continue;

    const os = /\bWindows\b/i.test(skuName) ? "Windows" : "Linux";
    const price = it?.unitPrice;
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = `${instance}-${os}-${AZURE_REGION}`;
    if (!uniq[key] || price < uniq[key].pricePerHourUSD) {
      uniq[key] = {
        instance,
        pricePerHourUSD: price,
        region: AZURE_REGION,
        os
      };
    }
  }

  return Object.values(uniq);
}

// ---------------------------
// AZURE ENRICHMENT (best-effort)
// ---------------------------
async function enrichAzureVmSizes(azureVMs) {
  if (!azureVMs.length) return azureVMs;

  try {
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    const armToken = process.env.ARM_TOKEN;

    if (!subscriptionId || !armToken) {
      console.warn("[Azure] Missing AZURE_SUBSCRIPTION_ID or ARM_TOKEN — enrichment skipped.");
      return azureVMs;
    }

    const vmSizesUrl =
      `https://management.azure.com/subscriptions/${subscriptionId}` +
      `/providers/Microsoft.Compute/locations/${AZURE_REGION}/vmSizes?api-version=2022-08-01`;

    const sizesRes = await fetch(vmSizesUrl, {
      headers: {
        "Authorization": `Bearer ${armToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!sizesRes.ok) {
      console.warn(`[Azure] vmSizes API HTTP ${sizesRes.status} — enrichment skipped`);
      return azureVMs;
    }

    const sizesJson = await sizesRes.json();
    const sizes = sizesJson?.value || [];
    const sizeMap = new Map(
      sizes.map(s => [String(s.name), { vcpu: s.numberOfCores, ram: (s.memoryInMB || 0) / 1024 }])
    );

    for (const vm of azureVMs) {
      const spec = sizeMap.get(vm.instance);
      if (spec) {
        vm.vcpu = spec.vcpu;
        vm.ram = spec.ram;
        vm.category =
          vm.instance.startsWith("D") ? "general" :
          vm.instance.startsWith("E") ? "memory" :
          vm.instance.startsWith("F") ? "compute" :
          "other";
      }
    }
  } catch (e) {
    console.warn(`[Azure] vmSizes enrichment error — skipped.`, e?.message || e);
  }
  return azureVMs;
}

// ---------------------------
// AZURE STORAGE (unchanged)
// ---------------------------
async function fetchAzureStorage() {
  console.log(`[Azure] Fetching Managed Disk prices…`);

  const url =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=armRegionName eq '${AZURE_REGION}' and contains(skuName,'Disk') and type eq 'Consumption'`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`[Azure] Storage pricing HTTP ${res.status}`);
  const json = await res.json();

  const ssd = {};
  const hdd = {};

  for (const item of json.Items || []) {
    const price = item.unitPrice;
    if (!Number.isFinite(price) || price <= 0) continue;

    // Extract size (GiB) if present
    const m = String(item.skuName || "").match(/(\d+)\s*GiB/i);
    if (!m) continue;
    const sizeGiB = m[1];

    if (/SSD/i.test(item.skuName)) {
      ssd[sizeGiB] = price;
    } else if (/HDD/i.test(item.skuName)) {
      hdd[sizeGiB] = price;
    }
  }

  return {
    ssd_monthly: ssd,
    hdd_monthly: hdd
  };
}

// ---------------------------
// ATOMIC WRITE HELPER
// ---------------------------
function writeAtomic(outPath, data) {
  const dir = path.dirname(outPath);
  const tmpPath = path.join(dir, "prices.tmp.json");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, outPath);
}

// ---------------------------
// MAIN with FAILOVER
// ---------------------------
async function main() {
  // Fetch in parallel (Azure enrichment depends on azure list later)
  const [aws, azureRaw, azureStorage] = await Promise.all([
    fetchAWSPrices(),
    fetchAzurePrices(),
    fetchAzureStorage().catch(e => {
      console.warn("[Azure] Storage fetch failed — continuing without storage.", e?.message || e);
      return { ssd_monthly: {}, hdd_monthly: {} };
    })
  ]);

  // ---- FAILOVER POLICY ----
  // If Azure OR AWS list is empty, DO NOT overwrite existing data/prices.json.
  if (!aws.length) {
    console.warn("⚠️ FAILOVER: AWS list is empty. Skipping write to avoid overwriting last-known-good data.");
    return; // exit 0
  }
  if (!azureRaw.length) {
    console.warn("⚠️ FAILOVER: Azure list is empty. Skipping write to avoid overwriting last-known-good data.");
    return; // exit 0
  }

  // Enrich Azure (best-effort, never throws)
  const azure = await enrichAzureVmSizes(azureRaw);

  const final = {
    meta: {
      os: ["Linux", "Windows"],
      vcpu: [...new Set(azure.map(v => v.vcpu).filter(Number.isFinite))].sort((a, b) => a - b),
      ram: [...new Set(azure.map(v => v.ram).filter(Number.isFinite))].sort((a, b) => a - b)
    },
    aws,
    azure,
    storage: {
      aws: {
        region: AWS_REGION,
        ssd_per_gb_month: 0.08,
        hdd_st1_per_gb_month: 0.045
      },
      azure: {
        region: AZURE_REGION,
        ...azureStorage
      }
    }
  };

  const outPath = "data/prices.json";
  writeAtomic(outPath, final);
  console.log(`✅ Successfully updated ${outPath}`);
}

main().catch(err => {
  console.error("❌ Error in fetch-prices:", err?.stack || err);
  // On *unexpected* fatal errors we still exit 1,
  // but the failover paths return early with code 0.
  process.exit(1);
});
