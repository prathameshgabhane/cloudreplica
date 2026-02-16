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

// ---- Pricing (Catalog API) ----
const CURRENCY = process.env.GCP_CURRENCY || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY; // GitHub Secret

// ---- Compute Engine metadata (OAuth fallback) ----
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID; // required only for fallback (machineTypes.list)

// Compute Engine service id per API examples. We bypass services.list.  [1](https://www.owox.com/blog/articles/bigquery-public-datasets)
const COMPUTE_SERVICE_ID = "6F81-5844-456A";

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

/* ---------------------------
 * Catalog API helpers (pricing)
 * ---------------------------
 * List SKUs for a service (paged, 5000/page). Supports currencyCode.  [1](https://www.owox.com/blog/articles/bigquery-public-datasets)
 */
async function listSkus(serviceId, pageToken = "") {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000&key=${API_KEY}`;
  const url  = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] skus HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

// Price extractor (units+nanos from tier 0).  [2](https://www.oracle.com/cloud/compute/pricing/)
function extractHourlyPrice(pricingInfo) {
  for (const p of pricingInfo || []) {
    const expr = p.pricingExpression;
    if (!expr || !expr.tieredRates?.[0]?.unitPrice) continue;
    const u = expr.tieredRates[0].unitPrice;
    const price = Number(u.units || 0) + Number(u.nanos || 0) / 1e9;
    if (price > 0) return price;
  }
  return null;
}

// Try to get machine type from attributes or displayName (e.g., n2-standard-4)
function inferMachineType(sku) {
  const attrs = sku.attributes || {};
  if (attrs.machineType) return String(attrs.machineType).toLowerCase();
  const s = (sku.displayName || "").toLowerCase();
  const m = s.match(/\b([a-z0-9]+-(?:standard|highmem|highcpu|c2d|c3|c4|c3d|c4d|c4a|n1|n2|n2d|n4|t2a|t2d|e2)-\d+)\b/);
  return m ? m[1] : null;
}

// Best-effort vCPU/RAM derivation (safe common cases only)
function deriveVcpuRamFromType(mt) {
  if (!mt) return { vcpu: undefined, ram: undefined };
  const m = mt.match(/^([a-z0-9]+)-([a-z]+[a-z0-9]*)-(\d+)$/);
  if (!m) return { vcpu: undefined, ram: undefined };
  const series = m[1];
  const cls    = m[2];
  const vcpu   = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };

  let per;

  if (series.startsWith("n1")) {
    if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 3.75 };
    if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 6.5 };
    if (cls.startsWith("highcpu"))  return { vcpu, ram: vcpu * 0.9 };
  }
  if (
    series.startsWith("n2") || series.startsWith("n2d") ||
    series.startsWith("e2") || series.startsWith("t2a") ||
    series.startsWith("t2d") || series.startsWith("n4") ||
    series.startsWith("c3")  || series.startsWith("c4")
  ) {
    if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 4 };
    if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 8 };
    if (cls.startsWith("highcpu"))  return { vcpu, ram: vcpu * 2 };
  }
  if (series.startsWith("c2")) return { vcpu, ram: vcpu * 4 };

  return { vcpu: undefined, ram: undefined };
}

/* ------------------------------------------------
 * Linux composition fallback helpers (Catalog side)
 * ------------------------------------------------
 * Identify Linux per‑unit SKUs like "N2 Instance Core running..." / "N2 Instance Ram running..."
 */
function parseSeriesUnitRate(sku) {
  const name = (sku.displayName || "").toLowerCase();
  if (/windows|license/i.test(name)) return null; // keep Linux-only for fallback

  const m = name.match(/\b(n1|n2d|n2|n4|e2|t2a|t2d|c2d|c3d|c3|c4d|c4|c4a|c2)\b.*\binstance\s+(core|ram)\b/i);
  if (!m) return null;

  const series = m[1].toLowerCase();
  const kind   = m[2].toLowerCase(); // "core" or "ram"
  const price  = extractHourlyPrice(sku.pricingInfo);
  if (!(price > 0)) return null;

  return { series, kind, price };
}

// Build Linux unit rate maps per series for the current REGION (Catalog API)
function buildSeriesUnitRateMaps(allSkus, region) {
  const maps = {}; // { [series]: { core?: rate, ram?: rate } }
  for (const sku of allSkus) {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;

    const regions = (sku.serviceRegions || []).map(r => r.toLowerCase());
    if (regions.length && !regions.includes(region.toLowerCase())) continue;

    const info = parseSeriesUnitRate(sku);
    if (!info) continue;

    if (!maps[info.series]) maps[info.series] = {};
    maps[info.series][info.kind] = info.price;
  }
  return maps;
}

function seriesFromMachineType(mt) {
  const m = String(mt || "").toLowerCase().match(/^([a-z0-9]+)-/);
  return m ? m[1] : null;
}

/* -----------------------------------------------
 * OAuth helpers for Compute API (machineTypes.list)
 * -----------------------------------------------
 * We’ll use Application Default Credentials (ADC). In GitHub Actions,
 * add google-github-actions/auth@v2 to fetch short-lived credentials.
 * Docs for machineTypes.list: [3](https://docs.cloud.google.com/workflows/docs/reference/googleapis/compute/v1/machineTypes/list)
 */
async function getAccessTokenFromADC() {
  // Lazy-load google-auth-library to avoid dependency unless fallback is used
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  if (!token || !token.token) throw new Error("[GCP] OAuth token not available from ADC");
  return token.token;
}

// List all zones in the project, then filter by region name prefix (e.g., "us-east1-")
async function listRegionZones(projectId, region, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones`;
  const zones = [];
  let pageToken = "";

  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] zones.list HTTP ${r.status} ${txt}`);
    }
    const j = await r.json();
    for (const z of j.items || []) {
      if (String(z.name).toLowerCase().startsWith(`${region.toLowerCase()}-`)) zones.push(z.name);
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return zones;
}

// For a given zone, list predefined machine types (exclude "custom-...")
async function listZoneMachineTypes(projectId, zone, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/machineTypes`;
  const mts = [];
  let pageToken = "";

  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] machineTypes.list HTTP ${r.status} ${txt}`);
    }
    const j = await r.json();
    for (const mt of j.items || []) {
      const name = String(mt.name || "");
      if (/^custom-/.test(name)) continue; // exclude custom
      // We need series-class-vcpu pattern to derive family later
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name)) continue;
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
}

/* ------------------------------
 * MAIN fetch: pricing + fallback
 * ------------------------------ */
async function fetchGcpPrices() {
  logStart("[GCP] Fetching retail PAYG pricing via Catalog API...");

  if (!API_KEY) throw new Error("[GCP] Missing GCP_PRICE_API_KEY");

  // 1) Pull ALL SKUs (paged) for Compute Engine service  [1](https://www.owox.com/blog/articles/bigquery-public-datasets)
  const allSkus = [];
  let pageToken = "";
  do {
    const { skus = [], nextPageToken } = await listSkus(COMPUTE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || "";
  } while (pageToken);

  // 2) Build Linux unit-rate maps per series (for composition fallback)
  const linuxSeriesRates = buildSeriesUnitRateMaps(allSkus, REGION);

  // 3) First pass: per‑instance SKUs (Linux + Windows)
  const gcp_price_list = {};
  let counter = 0;

  for (const sku of allSkus) {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;

    const regions = (sku.serviceRegions || []).map(r => r.toLowerCase());
    if (regions.length && !regions.includes(REGION.toLowerCase())) continue;

    const dn = sku.displayName || "";
    const isInstance = /Instance (?:running|hour)|Predefined Instance/i.test(dn);
    if (!isInstance) continue;

    // Machine type & family
    const mt = inferMachineType(sku);
    if (!mt) continue;

    const instance = mt.replace(/-/g, "_").toUpperCase();
    const fam = classifyGcpInstance(instance);
    if (!fam) continue;

    // OS: default Linux unless Windows explicitly present
    const os = /windows/i.test(dn) ? "Windows" : "Linux";

    // Price + hardware
    const price = extractHourlyPrice(sku.pricingInfo);
    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram  = a.memoryGb ? Number(a.memoryGb) : undefined;

    if (!vcpu || !ram) {
      const d = deriveVcpuRamFromType(mt);
      vcpu = vcpu || d.vcpu;
      ram  = ram  || d.ram;
    }

    if (!(price > 0) || !vcpu || !ram) continue;

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

  // 4) If Linux list is empty (or very small), compose Linux prices using CPU/RAM unit rates + machineTypes.list
  const haveAnyLinux = Object.values(gcp_price_list).some(v => v.os === "Linux");
  if (!haveAnyLinux) {
    if (!GCP_PROJECT_ID) {
      console.warn("[GCP] Linux fallback needed, but GCP_PROJECT_ID not set; cannot compose machine types. Skipping write to keep last-known-good file.");
      return { gcp_price_list }; // empty; bottom-half will skip write
    }

    // 4a) Get OAuth token via ADC (Workload Identity Federation in Actions)
    const token = await getAccessTokenFromADC();  // [3](https://docs.cloud.google.com/workflows/docs/reference/googleapis/compute/v1/machineTypes/list)

    // 4b) Discover all zones for the region and list machine types across those zones
    const zones = await listRegionZones(GCP_PROJECT_ID, REGION, token);   // [3](https://docs.cloud.google.com/workflows/docs/reference/googleapis/compute/v1/machineTypes/list)
    const mtMap = new Map(); // machine_type -> { vcpu, ramGiB }

    for (const z of zones) {
      const mts = await listZoneMachineTypes(GCP_PROJECT_ID, z, token);   // [3](https://docs.cloud.google.com/workflows/docs/reference/googleapis/compute/v1/machineTypes/list)
      for (const mt of mts) {
        const name = String(mt.name).toLowerCase();               // e.g., n2-standard-4
        if (!mtMap.has(name)) {
          const vcpu = Number(mt.guestCpus || 0);
          const ramGiB = Number(mt.memoryMb || 0) / 1024;
          if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
        }
      }
    }

    // 4c) Compose Linux price for each machine type using series unit rates
    for (const [mt, hw] of mtMap.entries()) {
      const inst = mt.replace(/-/g, "_").toUpperCase();
      const fam  = classifyGcpInstance(inst);
      if (!fam) continue; // respect your allowed families

      const series = seriesFromMachineType(mt);
      const rates  = series ? linuxSeriesRates[series] : undefined;
      if (!rates || !rates.core || !rates.ram) continue; // need both unit rates

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

  logDone("[GCP] Pricing file loaded");
  return { gcp_price_list };
}

/* --------------------
 * Bottom half (unchanged)
 * -------------------- */
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

  // Storage mapping (constant) — can be made dynamic later via PD SKUs
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
