// scripts/fetch-prices.js — CommonJS + Node18 native fetch
// Features:
// - AWS de-duplication (cheapest per instance-OS-region)
// - Azure de-duplication (cheapest per instance-OS-region)
// - Best-effort Azure enrichment via ResourceSkus (vCPUs, MemoryGB)
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

// Families to keep for Azure (broad & forward-compatible)
const ALLOWED_AZURE_SERIES = ["A", "B", "D", "E", "F", "L", "M", "N"];

// AWS families to keep
const EC2_PREFIXES = ["m", "c", "r", "t", "x", "i", "z", "h"];

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

  const unique = {}; // keep cheapest per (instance, OS, region)

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
      unique[key] = { instance, vcpu, ram, pricePerHourUSD: price, region: AWS_REGION, os };
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

  // Pay-as-you-go compute meters; filters are case-sensitive in newer API versions.
  // serviceName eq 'Virtual Machines', region match, 'Consumption' (PAYG).
  // We split OS later via productName (Windows tokens).
  const baseUrl =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${AZURE_REGION}' and type eq 'Consumption'`;

  const items = [];
  let next = baseUrl;
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

  if (!items.length) {
    console.warn("[Azure] Retail API returned 0 items.");
    return [];
  }

  // Keep cheapest per (instance, OS, region)
  const uniq = {};
  for (const it of items) {
    const skuName = it?.skuName || "";
    const armSkuName = it?.armSkuName || "";
    const rawInstance = (skuName.split(" ")[0] || armSkuName || "").trim(); // e.g., Standard_D4s_v5
    const instance = rawInstance || armSkuName;
    if (!instance) continue;

    // Allowed series check by first letter
    const instLower = instance.toLowerCase();
    const lead = (instLower.startsWith("standard_") ? instLower.slice(9) : instLower)[0];
    if (!lead || !ALLOWED_AZURE_SERIES.includes(lead.toUpperCase())) continue;

    // OS via productName (Windows token)
    const os = /windows/i.test(it.productName || "") ? "Windows" : "Linux"; // <-- reliable split

    const price = it?.unitPrice;
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = `${instance}-${os}-${AZURE_REGION}`;
    if (!uniq[key] || price < uniq[key].pricePerHourUSD) {
      uniq[key] = { instance, pricePerHourUSD: price, region: AZURE_REGION, os };
    }
  }

  return Object.values(uniq);
}

// ---------------------------
// AZURE ENRICHMENT via ResourceSkus (vCPUs, MemoryGB)
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

    // Complete per-region SKU list with capabilities (vCPUs, MemoryGB)
    const url =
      `https://management.azure.com/subscriptions/${subscriptionId}` +
      `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${AZURE_REGION}'`;

    const all = [];
    let next = url, pages = 0, MAX = 80;

    while (next && pages < MAX) {
      const res = await fetch(next, {
        headers: { Authorization: `Bearer ${armToken}` }
      });
      if (!res.ok) {
        console.warn(`[Azure] ResourceSkus HTTP ${res.status} — enrichment skipped`);
        return azureVMs;
      }
      const j = await res.json();
      all.push(...(j.value || []));
      next = j.nextLink || null;
      pages++;
    }

    // Build map: SKU name -> { vcpu, ram }
    const skuMap = new Map();
    for (const sku of all) {
      if (sku.resourceType !== "virtualMachines") continue;
      const caps = Object.fromEntries((sku.capabilities || []).map(x => [x.name, x.value]));
      const vcpus = caps.vCPUs ? Number(caps.vCPUs) : null;
      const memGB = caps.MemoryGB ? Number(caps.MemoryGB) : null;
      if (vcpus || memGB) skuMap.set(String(sku.name).toLowerCase(), { vcpu: vcpus, ram: memGB });
    }

    // Fill specs; assign a simple category if missing
    for (const vm of azureVMs) {
      const key = String(vm.instance || "").toLowerCase();
      const spec = skuMap.get(key);
      if (spec) {
        vm.vcpu = vm.vcpu ?? spec.vcpu ?? null;
        vm.ram  = vm.ram  ?? spec.ram  ?? null;
      }

      if (!vm.category) {
        const n = key.startsWith("standard_") ? key.slice(9) : key;
        const first = n[0];
        vm.category =
          first === "d" ? "general" :
          first === "e" ? "memory"  :
          first === "f" ? "compute" : "other";
      }
    }
  } catch (e) {
    console.warn(`[Azure] ResourceSkus enrichment error — skipped.`, e?.message || e);
  }
  return azureVMs;
}

// ---------------------------
// AZURE STORAGE (unchanged pattern)
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

  return { ssd_monthly: ssd, hdd_monthly: hdd };
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
  // Fetch in parallel
  const [aws, azureRaw, azureStorage] = await Promise.all([
    fetchAWSPrices(),
    fetchAzurePrices(),
    fetchAzureStorage().catch(e => {
      console.warn("[Azure] Storage fetch failed — continuing without storage.", e?.message || e);
      return { ssd_monthly: {}, hdd_monthly: {} };
    })
  ]);

  // FAILOVER POLICY: do not overwrite if a provider failed
  if (!aws.length) {
    console.warn("⚠️ FAILOVER: AWS list is empty. Skipping write to avoid overwriting last-known-good data.");
    return;
  }
  if (!azureRaw.length) {
    console.warn("⚠️ FAILOVER: Azure list is empty. Skipping write to avoid overwriting last-known-good data.");
    return;
  }

  // Enrich Azure (best-effort)
  const azure = await enrichAzureVmSizes(azureRaw);

  const final = {
    meta: {
      os: ["Linux", "Windows"],
      vcpu: [...new Set(azure.map(v => v.vcpu).filter(Number.isFinite))].sort((a, b) => a - b),
      ram:  [...new Set(azure.map(v => v.ram ).filter(Number.isFinite))].sort((a, b) => a - b)
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
  process.exit(1);
});
