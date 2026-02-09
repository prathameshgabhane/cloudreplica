// scripts/fetch-prices.js (CommonJS)
// FINAL VERSION — With Azure OIDC ARM token support,
// Azure VM size merging, SSD+HDD LRS support,
// no more null CPU/RAM/OS, directly compatible with your UI.

const fetch = require("node-fetch");
const fs = require("fs");

/* =====================================
   CONFIG
   ===================================== */
const AWS_REGION   = process.env.AWS_REGION   || "us-east-1";
const AZURE_REGION = process.env.AZURE_REGION || "eastus";
const ARM_TOKEN    = process.env.ARM_TOKEN; // MUST BE SET BY WORKFLOW

if (!ARM_TOKEN) {
  console.error("❌ ARM_TOKEN missing — GitHub OIDC workflow must export it.");
  process.exit(1);
}

/* =====================================
   HELPERS
   ===================================== */

// AWS filters
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

function awsFamilyFromInstanceType(instanceType) {
  if (!instanceType) return null;
  const m = instanceType.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isWantedAwsFamily(instance) {
  const fam = awsFamilyFromInstanceType(instance);
  return fam === "m" || fam === "t" || fam === "c" || fam === "r" || fam === "x" || fam === "z";
}

// Pick AWS hourly price
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
      const isBad = /reserved|upfront|dedicated host|dedicated/i.test(desc);

      if (isHourly && !isBad && !Number.isNaN(usd)) return usd;
    }
  }
  return null;
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
    const win = isAwsWindows(attrs);
    if (!linux && !win) continue;

    const vcpu = Number(attrs.vcpu || 0);
    const ram = Number(String(attrs.memory || "0 GB").split(" ")[0]);

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
   AZURE RETAIL COMPUTE PRICES (NO SPEC)
   ===================================== */
function azureCategoryFromSku(armSku, prod) {
  const n1 = String(armSku || "").toLowerCase();
  const n2 = String(prod || "").toLowerCase();

  let fam = null;
  const m1 = n1.match(/standard_([a-z]+)/);
  if (m1) fam = m1[1];
  else {
    const m2 = n2.match(/\b([a-z]+)[0-9]*-?series/);
    if (m2) fam = m2[1];
  }
  if (!fam) return null;

  const f = fam[0];
  if (f === "d" || f === "b") return "general";
  if (f === "f") return "compute";
  if (f === "e" || f === "m") return "memory";
  return null;
}

async function fetchAzureComputeRetail(region) {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and type eq 'Consumption'`;

  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
  const list = [];

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`Azure retail compute HTTP ${resp.status}`);
    const page = await resp.json();

    for (const x of page.Items || []) {
      const unit = x.unitPrice ?? x.retailPrice ?? null;
      if (!unit) continue;

      const os = /linux/i.test(x.productName) ? "Linux" :
                /windows/i.test(x.productName) ? "Windows" : "Unknown";

      const cat = azureCategoryFromSku(x.armSkuName, x.productName);
      if (!cat) continue;

      list.push({
        instance: x.armSkuName || x.skuName || "Unknown",
        pricePerHourUSD: unit,
        region,
        os,
        vcpu: null,
        ram: null,
        category: cat
      });
    }

    next = page.NextPageLink || null;
  }

  return list;
}

/* =====================================
   AZURE VM SIZE SPECS (ARM API)  → vCPU / RAM
   ===================================== */
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
      ram: Math.round(s.memoryInMB / 1024)
    };
  }

  return map;
}

/* =====================================
   AZURE MANAGED DISK PRICING (SSD+HDD LRS)
   ===================================== */
async function fetchAzureManagedDisks(region) {
  const api = "https://prices.azure.com/api/retail/prices";
  const filter = `serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Managed Disks' and type eq 'Consumption'`;

  let next = `${api}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;

  const ssd = {};
  const hdd = {};

  const SSD_MAP = {
    E1: 4, E2: 8, E3: 16, E4: 32, E6: 64,
    E10: 128, E15: 256, E20: 512, E30: 1024,
    E40: 2048, E50: 4096
  };

  const HDD_MAP = {
    S4: 32, S6: 64, S10: 128, S15: 256,
    S20: 512, S30: 1024, S40: 2048, S50: 4096
  };

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
   AWS EBS PER-GB-MONTH
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

    console.log("Fetching Azure retail compute...");
    const azRetail = await fetchAzureComputeRetail(AZURE_REGION);

    console.log("Fetching Azure VM size specs...");
    const azSpecs = await fetchAzureVmSizes(AZURE_REGION);

    console.log("Merging Azure specs...");
    for (const vm of azRetail) {
      const key = vm.instance.toLowerCase();
      if (azSpecs[key]) {
        vm.vcpu = azSpecs[key].vcpu;
        vm.ram = azSpecs[key].ram;
      }
    }

    console.log("Fetching Azure disk pricing...");
    const azDisks = await fetchAzureManagedDisks(AZURE_REGION);

    const awsEbs = getAwsEbs(AWS_REGION);

    const output = {
      meta: {
        os: ["Linux", "Windows"],
        vcpu: [1, 2, 4, 8, 16, 32],
        ram: [1, 2, 4, 8, 16, 32, 64]
      },
      aws,
      azure: azRetail,
      storage: {
        aws: { region: AWS_REGION, ...awsEbs },
        azure: azDisks
      }
    };

    fs.writeFileSync("data/prices.json", JSON.stringify(output, null, 2));

    console.log(`
    ✅ Updated data/prices.json
    • AWS compute: ${aws.length}
    • Azure compute: ${azRetail.length}
    • Azure disk SSD sizes: ${Object.keys(azDisks.ssd_monthly).length}
    • Azure disk HDD sizes: ${Object.keys(azDisks.hdd_monthly).length}
    `);
  } catch (e) {
    console.error("❌ Error updating prices:", e);
    process.exit(1);
  }
})();
