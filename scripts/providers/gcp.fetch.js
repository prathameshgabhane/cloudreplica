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

const {
  CE_SERVICE_ID,
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  // FULL-mode helpers
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps
} = require("../lib/gcp");

// Output & env
const OUT       = path.join("data", "gcp", "gcp.prices.json");
const REGION    = process.env.GCP_REGION    || "us-east1";
const CURRENCY  = process.env.GCP_CURRENCY  || "USD";
const API_KEY   = process.env.GCP_PRICE_API_KEY;  // Catalog
const PROJECT   = process.env.GCP_PROJECT_ID;     // for Compute API fallback

// Catalog: list SKUs (paged)
async function listSkus(serviceId, pageToken = "") {
  const base =
    `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus` +
    `?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000&key=${API_KEY}`;
  const url  = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;

  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] skus HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

async function fetchGcpPrices() {
  logStart("[GCP] Fetching PAYG pricing via Catalog API (with FULL-mode fallback)…");

  if (!API_KEY) throw new Error("[GCP] Missing GCP_PRICE_API_KEY");

  // 1) Pull all SKUs for Compute Engine (Catalog)
  const allSkus = [];
  let pageToken = "";
  do {
    const { skus = [], nextPageToken } = await listSkus(CE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || "";
  } while (pageToken);

  // Build Linux unit-rate maps (Core/Ram per series) for fallback
  const linuxSeriesRates = buildSeriesUnitRateMaps(allSkus, REGION);

  // 2) First pass: per‑instance SKUs (Linux + Windows)
  const gcp_price_list = {};
  let counter = 0;

  for (const sku of allSkus) {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;

    if (!regionMatches(sku.serviceRegions, REGION)) continue;

    const mt = inferMachineType(sku);
    if (!mt) continue;
    if (!isPerInstanceSku(sku, mt)) continue;

    const instTok = mt.replace(/-/g, "_").toUpperCase();
    const fam = classifyGcpInstance(instTok);
    if (!fam) continue;

    const os    = /windows/i.test(sku.displayName || "") ? "Windows" : "Linux";
    const price = extractHourlyPrice(sku.pricingInfo);
    if (!(price > 0)) continue;

    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram  = a.memoryGb ? Number(a.memoryGb) : undefined;
    if (!vcpu || !ram) {
      const d = deriveVcpuRamFromType(mt);
      vcpu = vcpu || d.vcpu;
      ram  = ram  || d.ram;
    }
    if (!vcpu || !ram) continue;

    const key = `sku_${++counter}`;
    gcp_price_list[key] = {
      region: REGION,
      machine_type: mt,
      os,
      price_per_hour: price,
      vcpu,
      memory_gb: ram
    };
  }

  // 3) Fallback: compose Linux prices using CPU/RAM unit rates + machineTypes.list
  const haveLinux = Object.values(gcp_price_list).some(v => v.os === "Linux");
  if (!haveLinux) {
    if (!PROJECT) {
      console.warn("[GCP] Fallback needed but GCP_PROJECT_ID not set; skipping composition.");
    } else {
      const token = await getAccessTokenFromADC();                // OIDC
      const zones = await listRegionZones(PROJECT, REGION, token);
      const mtMap = new Map(); // machine_type -> { vcpu, ramGiB }

      for (const z of zones) {
        const mts = await listZoneMachineTypes(PROJECT, z, token);
        for (const mt of mts) {
          const name = String(mt.name).toLowerCase();             // e.g., n2-standard-4
          if (!mtMap.has(name)) {
            const vcpu = Number(mt.guestCpus || 0);
            const ramGiB = Number(mt.memoryMb || 0) / 1024;
            if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
          }
        }
      }

      for (const [mt, hw] of mtMap.entries()) {
        const instTok = mt.replace(/-/g, "_").toUpperCase();
        const fam = classifyGcpInstance(instTok);
        if (!fam) continue;

        // series = token before first dash
        const series = mt.split("-")[0];           // e.g., "n2"
        const rates  = linuxSeriesRates[series];
        if (!rates || !rates.core || !rates.ram) continue;

        const price = hw.vcpu * rates.core + hw.ramGiB * rates.ram;
        if (!(price > 0)) continue;

        const key = `sku_${++counter}`;
        gcp_price_list[key] = {
          region: REGION,
          machine_type: mt,
          os: "Linux",
          price_per_hour: price,
          vcpu: hw.vcpu,
          memory_gb: hw.ramGiB
        };
      }
    }
  }

  if (Object.keys(gcp_price_list).length === 0) {
    const sample = allSkus
      .filter(s => (s.category?.resourceFamily === "Compute") && regionMatches(s.serviceRegions, REGION))
      .slice(0, 15)
      .map(s => s.displayName);
    console.warn(`[GCP] DEBUG: 0 rows after per-instance and composition in '${REGION}'. Sample:\n${JSON.stringify(sample, null, 2)}`);
  }

  logDone("[GCP] Pricing file loaded");
  return { gcp_price_list };
}

async function main() {
  const json = await fetchGcpPrices();

  const rows = [];
  const skus = json.gcp_price_list || {};

  for (const key in skus) {
    const item = skus[key];
    if (!item || typeof item !== "object") continue;
    if (!item.region || item.region !== REGION) continue;
    if (!item.machine_type) continue;

    const instance = item.machine_type.replace(/-/g, "_");
    const category = classifyGcpInstance(instance);
    if (!category) continue;

    const os = item.os && item.os.toLowerCase().includes("win") ? "Windows" : "Linux";
    const price = Number(item.price_per_hour);
    if (!Number.isFinite(price) || price <= 0) continue;

    const vcpu = Number(item.vcpu);
    const ram  = Number(item.memory_gb);
    if (!vcpu || !ram) continue;

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

  const cheapest = dedupeCheapestByKey(
    rows,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);
  if (warnAndSkipWriteOnEmpty("GCP", cheapest)) return;

  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // (Static storage placeholders; can be replaced with PD SKUs later)
  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.17,
    hdd_per_gb_month: 0.04
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
