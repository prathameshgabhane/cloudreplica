// scripts/providers/gcp.fetch.js
// Node 18+ (global fetch)

const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");

// Output path
const OUT = path.join("data", "gcp", "gcp.prices.json");

// Default region (aligned with AWS us-east-1 and Azure eastus)
const REGION = process.env.GCP_REGION || "us-east1";

/**
 * GCP Price List API (PUBLIC MIRROR THAT STILL WORKS)
 * Google removed the old appspot endpoint.
 * This GCS-hosted mirror is the correct one to use.
 */
const GCP_PRICING_URL =
  "https://storage.googleapis.com/cloudpricingcalculator.appspot.com/static/data/pricelist.json";

/**
 * Allowed VM families for our tool:
 * General: N1, N2, N2D, N4, N4A, N4D, C3, C3D, E2, T2A, T2D
 * Compute: C2, C2D, H3, H4D
 * Memory:  M1, M2, M3, M4
 */
function classifyGcpInstance(instance) {
  const name = String(instance).toUpperCase();

  // Memory Optimized
  if (name.startsWith("M1") || name.startsWith("M2") || name.startsWith("M3") || name.startsWith("M4"))
    return "memory";

  // Compute Optimized
  if (name.startsWith("C2") || name.startsWith("C2D") || name.startsWith("H3") || name.startsWith("H4D"))
    return "compute";

  // General Purpose
  const generalFamilies = [
    "C3","C3D","C4","C4D","C4A",
    "N1","N2","N2D","N4","N4A","N4D",
    "T2A","T2D","E2"
  ];
  if (generalFamilies.some(f => name.startsWith(f))) return "general";

  return null;
}

async function fetchGcpPrices() {
  logStart("[GCP] Fetching retail PAYG pricing...");

  const res = await fetch(GCP_PRICING_URL);
  if (!res.ok) throw new Error(`[GCP] Pricing HTTP ${res.status}`);

  const data = await res.json();
  logDone("[GCP] Pricing file loaded");

  return data;
}

async function main() {
  const json = await fetchGcpPrices();

  const rows = [];
  const skus = json.gcp_price_list || {};

  // Traverse all SKU entries
  for (const key in skus) {
    const item = skus[key];

    if (!item || typeof item !== "object") continue;
    if (!item.region || item.region !== REGION) continue;
    if (!item.machine_type) continue;

    const instance = item.machine_type.replace(/-/g, "_"); // normalize slightly
    const category = classifyGcpInstance(instance);
    if (!category) continue;

    // OS detection
    const os = item.os && item.os.toLowerCase().includes("win")
      ? "Windows"
      : "Linux"; // Linux free PAYG

    const price = Number(item.price_per_hour);
    if (!Number.isFinite(price) || price <= 0) continue;

    const vcpu = Number(item.vcpu);
    const ram  = Number(item.memory_gb);
    if (!vcpu || !ram) continue; // ensure no null values

    rows.push({
      instance,
      category,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region: REGION,
      os
    });
  }

  // Deduplicate cheapest per instance-region-OS
  const cheapest = dedupeCheapestByKey(
    rows,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);

  if (warnAndSkipWriteOnEmpty("GCP", cheapest)) return;

  // Meta construction
  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Storage mapping (constant)
  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.17,   // PD‑SSD
    hdd_per_gb_month: 0.04    // PD‑Standard
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
