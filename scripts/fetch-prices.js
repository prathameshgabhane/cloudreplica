// scripts/fetch-prices.js (CommonJS)
// Azure PAYG (Linux + Windows) by modern series only, OS-strict, de-duped;
// ARM "/vmSizes" enrichment for vCPU/RAM; AWS unchanged.

const fetch = require("node-fetch");
const fs = require("fs");

/* =====================================
   CONFIG
===================================== */
const AWS_REGION   = process.env.AWS_REGION   || "us-east-1";
const AZURE_REGION = process.env.AZURE_REGION || "eastus";
const ARM_TOKEN    = process.env.ARM_TOKEN;              // Azure AD OIDC token
const AZ_SUB_ID    = process.env.AZURE_SUBSCRIPTION_ID;  // subscription for /vmSizes

if (!ARM_TOKEN) {
  console.error("❌ ARM_TOKEN missing — CI must export it (OIDC to Azure).");
  process.exit(1);
}
if (!AZ_SUB_ID) {
  console.error("❌ AZURE_SUBSCRIPTION_ID missing — required for /vmSizes.");
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

/* =====================================
   AZURE — modern series classifier (parser-based)
===================================== */
/**
 * Retail API armSkuName examples:
 *   Standard_D4s_v5, Standard_D8ads_v5, Standard_E16as_v5, Standard_F8s_v2,
 *   Standard_B2ps_v2, Standard_D2ps_v5, Standard_E16ps_v5 …
 */

// Get 'standard_<stuff>' family token (lowercased)
function parseAzureFamilyToken(name) {
  const m = String(name || '').toLowerCase().match(/^standard_([a-z0-9]+)\b/);
  return m ? m[1] : '';
}

// Extract version number from `_v#`
function parseAzureVersion(name) {
  const m = String(name || '').toLowerCase().match(/_v(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Return category: 'general' | 'compute' | 'memory' | null (filtered out)
 * Modern-only rules based on family letter + version:
 *   D (v5/6/7)  -> general (includes Das/Dads/Dd/Dps subfamilies)
 *   B (v2 only) -> general (Bsv2/Basv2/Bpsv2)
 *   F (v2 or v6/7) -> compute (Fsv2 and newer F* v6/v7 families)
 *   E (v5) -> memory (Ev5/Esv5/Edv5/Ebsv5)
 */
function azureCategoryFromSkuName(armSkuName, productName) {
  const name = String(armSkuName || productName || '').toLowerCase();
  if (!name.startsWith('standard_')) return null;

  const token = parseAzureFamilyToken(name);  // e.g., 'd4ads', 'e16as', 'f8s', 'b2ps'
  if (!token) return null;

  const version = parseAzureVersion(name);    // 2, 5, 6, 7
  const familyLetter = token[0];              // 'd','e','f','b', etc.

  switch (familyLetter) {
    case 'd':
      return (version && version >= 5) ? 'general' : null;
    case 'b':
      return /_v2\b/.test(name) ? 'general' : null;
    case 'f':
      return (version === 2 || (version && version >= 6)) ? 'compute' : null;
    case 'e':
      return (version === 5) ? 'memory' : null;
    default:
      return null;
  }
}

// ARM indicator: 'p' immediately after the family letter => Arm-based processor
// e.g., Standard_B2ps_v2, Standard_D4ps_v5, Standard_E16ps_v5
function isArmSku(instance) {
  const s = String(instance || '').toLowerCase();
  return /^standard_[deb]p/.test(s);
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
   AZURE RETAIL (PAYG) — Linux & Windows
===================================== */
/**
 * Query Retail Prices API twice (Linux + Windows), keep only modern
 * series by category; enrich with vCPU/RAM via ARM /vmSizes later.
 *
 * Docs note: filter values are case-sensitive in 2023-01-01-preview.
 * Use contains(productName, 'Linux'|'Windows'), not 'Ubuntu'.  (Linux base rows)
 */

async function fetchAzureRetailByOs(region, os /* 'Linux' | 'Windows' */) {
  const api = "https://prices.azure.com/api/retail/prices";
  const osNeedle = os === 'Linux' ? "Linux" : "Windows";
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
      if (!category) continue; // skip non-modern series

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
  console.log(`Azure Retail fetch for region ${region} (Linux & Windows) ...`);
  const linuxRows = await fetchAzureRetailByOs(region, 'Linux');
  const winRows   = await fetchAzureRetailByOs(region, 'Windows');

  console.log(`• Retail items pre-filter → Linux: ${linuxRows.length}, Windows: ${winRows.length}`);

  const all = [...linuxRows, ...winRows];

  // Linux-only guard for ARM families (e.g., Bpsv2 / Dpsv5 / Epsv5)
  const filtered = all.filter(r => !(isArmSku(r.instance) && r.os === 'Windows'));

  // De-dupe per (instance|region|os) keeping the lowest hourly price
  const key = r => `${r.instance.toLowerCase()}|${r.region.toLowerCase()}|${r.os}`;
  const map = new Map();
  for (const r of filtered) {
    const k = key(r);
    const cur = map.get(k);
    if (!cur || r.pricePerHourUSD < cur.pricePerHourUSD) map.set(k, r);
  }
  const finalRows = Array.from(map.values());
  console.log(`• Retail items after modern+ARM filters: ${finalRows.length}`);

  return finalRows;
}

/* =====================================
   AZURE VM SIZE SPECS (ARM) → vCPU / RAM
===================================== */
// Region sizes endpoint — authoritative for cores/RAM per size in region
async function fetchAzureVmSizes(region) {
  const url = `https://management.azure.com/subscriptions/${AZ_SUB_ID}/providers/Microsoft.Compute/locations/${region}/vmSizes?api-version=2022-03-01`;
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
  const filter = `serviceName eq 'Storage' and armRegionName eq '${region}'
                  and contains(productName, 'Managed Disks') and type eq 'Consumption'`;
  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;

  const ssd = {};
  const hdd = {};

  // Bands (GiB) for Premium SSD v2 (E*) and Standard HDD (S*)
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

    console.log("Fetching Azure retail compute (Linux + Windows; modern series)...");
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
        os: ["Linux", "Windows"],
        vcpu: [1, 2, 4, 8, 16, 32],
        ram:  [1, 2, 4, 8, 16, 32, 64]
      },
      aws,
      // OS-strict, modern-only (D v5/6/7; B v2; F v2/6/7; E v5),
      // enriched with vCPU/RAM (region availability), ARM Linux-only enforced.
      azure: azRetail,
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
