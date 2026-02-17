// docs/ui/state.js
// Single source of truth for prices the UI loads: docs/data/prices.json

export const API_BASE = "./data/prices.json";

// Defaults for dropdown meta (used if merged file omits/has sparse meta)
export const FALLBACK_META = {
  os:   [{ value: "Linux" }, { value: "Windows" }],
  vcpu: [1, 2, 4, 8, 16],
  ram:  [1, 2, 4, 8, 16, 32]
};

// In-memory storage pricing defaults (overridden/merged by prices.json when present)
export let STORAGE_CFG = {
  aws:  {
    region: "us-east-1",
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  },
  azure:{
    region: "eastus",
    // DISK tables in monthly USD used by your utils.js helpers
    ssd_monthly: {4:0.3,8:0.6,16:1.2,32:2.4,64:4.8,128:9.6,256:19.2,512:38.4},
    hdd_monthly: {32:1.536,64:3.008,128:5.888,256:11.328}
  },
  gcp: {
    region: "us-east1",
    ssd_per_gb_month: 0.17,   // PD-SSD typical retail
    hdd_per_gb_month: 0.04    // PD-Standard typical retail
  }
};

/**
 * Loads the aggregated file (docs/data/prices.json),
 * tolerates both WRAPPED and FLAT shapes, normalizes to:
 *   { meta, azure:[], aws:[], gcp:[], generatedAt? }
 * Also merges any `storage` blocks over STORAGE_CFG (without wiping defaults).
 */
export async function loadPricesAndMeta() {
  // Cache-buster avoids GH Pages CDN serving previous JSON after CI pushes
  const url = `${API_BASE}?v=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to read ${API_BASE} (HTTP ${r.status})`);
  const raw = await r.json();

  // Normalize structure:
  // 1) WRAPPED → FLAT
  //    { azure:{compute,meta?}, aws:{…}, gcp:{…}, generatedAt? }
  // 2) FLAT (preferred) → already flat
  let azure = [];
  let aws   = [];
  let gcp   = [];
  let meta  = {};

  const looksWrapped =
    raw && typeof raw === "object" &&
    raw.azure && raw.aws && raw.gcp &&
    !Array.isArray(raw.azure) && !Array.isArray(raw.aws) && !Array.isArray(raw.gcp);

  if (looksWrapped) {
    // Tolerate older/alternate aggregator output
    azure = Array.isArray(raw.azure?.compute) ? raw.azure.compute : [];
    aws   = Array.isArray(raw.aws?.compute)   ? raw.aws.compute   : [];
    gcp   = Array.isArray(raw.gcp?.compute)   ? raw.gcp.compute   : [];
    // Try to reuse any meta inside wrapped providers if present
    meta  = raw.meta || raw.azure?.meta || raw.aws?.meta || raw.gcp?.meta || {};
  } else {
    // Flat shape
    azure = Array.isArray(raw.azure) ? raw.azure : [];
    aws   = Array.isArray(raw.aws)   ? raw.aws   : [];
    gcp   = Array.isArray(raw.gcp)   ? raw.gcp   : [];
    meta  = raw.meta || {};
  }

  // ---- Merge storage overrides safely (do not wipe defaults) ----
  // Aggregated file may not include `storage` (our current CI doesn’t add it).
  const incomingStorage = raw.storage || {};
  const incomingAws     = incomingStorage.aws   || {};
  const incomingAzure   = incomingStorage.azure || {};
  const incomingGcp     = incomingStorage.gcp   || {};

  STORAGE_CFG = {
    aws: {
      region: incomingAws.region ?? STORAGE_CFG.aws.region,
      ssd_per_gb_month: Number(
        incomingAws.ssd_per_gb_month ?? STORAGE_CFG.aws.ssd_per_gb_month
      ),
      hdd_st1_per_gb_month: Number(
        incomingAws.hdd_st1_per_gb_month ?? STORAGE_CFG.aws.hdd_st1_per_gb_month
      )
    },
    azure: {
      region: incomingAzure.region ?? STORAGE_CFG.azure.region,
      // Merge disk tables (missing sizes fall back to defaults)
      ssd_monthly: { ...(STORAGE_CFG.azure.ssd_monthly || {}), ...(incomingAzure.ssd_monthly || {}) },
      hdd_monthly: { ...(STORAGE_CFG.azure.hdd_monthly || {}), ...(incomingAzure.hdd_monthly || {}) }
    },
    gcp: {
      region: incomingGcp.region ?? STORAGE_CFG.gcp.region,
      ssd_per_gb_month: Number(
        incomingGcp.ssd_per_gb_month ?? STORAGE_CFG.gcp.ssd_per_gb_month
      ),
      hdd_per_gb_month: Number(
        incomingGcp.hdd_per_gb_month ?? STORAGE_CFG.gcp.hdd_per_gb_month
      )
    }
  };

  // ---- Defensive meta fallback (ensure arrays) ----
  const normMeta = {
    os:   Array.isArray(meta.os)   && meta.os.length   ? meta.os   : FALLBACK_META.os.map(x => x.value),
    vcpu: Array.isArray(meta.vcpu) && meta.vcpu.length ? meta.vcpu : FALLBACK_META.vcpu,
    ram:  Array.isArray(meta.ram)  && meta.ram.length  ? meta.ram  : FALLBACK_META.ram
  };

  return {
    meta: normMeta,
    azure,
    aws,
    gcp,
    generatedAt: raw.generatedAt
  };
}
