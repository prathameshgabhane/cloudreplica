// docs/ui/state.js
export const API_BASE = "./data/prices.json";

// Defaults for dropdown meta
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
    ssd_monthly: {4:0.3,8:0.6,16:1.2,32:2.4,64:4.8,128:9.6,256:19.2,512:38.4},
    hdd_monthly: {32:1.536,64:3.008,128:5.888,256:11.328}
  },

  // ⭐ NEW: Default GCP storage config
  gcp: {
    region: "us-east1",
    ssd_per_gb_month: 0.17,   // PD-SSD typical retail
    hdd_per_gb_month: 0.04    // PD-Standard typical retail
  }
};

/**
 * Loads the aggregated prices.json from docs/data/prices.json,
 * merges storage tables over defaults (do not replace entirely),
 * and returns the parsed data (meta + aws[] + azure[] + gcp[] + storage).
 */
export async function loadPricesAndMeta() {
  const r = await fetch(API_BASE, { mode: "cors" });
  if (!r.ok) throw new Error(`Failed to read ${API_BASE}`);
  const data = await r.json();

  // ---- Merge storage config safely (do not wipe defaults) ----
  const incomingAws   = data?.storage?.aws   || {};
  const incomingAzure = data?.storage?.azure || {};
  const incomingGcp   = data?.storage?.gcp   || {};   // ⭐ NEW

  STORAGE_CFG = {
    aws: {
      region: incomingAws.region ?? STORAGE_CFG.aws.region,
      ssd_per_gb_month: Number(
        incomingAws.ssd_per_gb_month ?? STORAGE_CFG.aws.ssd_per_gb_month
      ),
      hdd_st1_per_gb_month: Number(
        incomingAws.hdd_st1_per_gb_month ?? STORAGE_CFG.aws.hdd_st1_per_gb_month
      ),
    },
    azure: {
      region: incomingAzure.region ?? STORAGE_CFG.azure.region,
      // MERGE tables so missing sizes fall back to defaults
      ssd_monthly: { ...(STORAGE_CFG.azure.ssd_monthly || {}), ...(incomingAzure.ssd_monthly || {}) },
      hdd_monthly: { ...(STORAGE_CFG.azure.hdd_monthly || {}), ...(incomingAzure.hdd_monthly || {}) },
    },

    // ⭐ NEW: GCP merge logic (simple values, not size-tables)
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

  // ---- Defensive meta fallback ----
  const meta = data.meta || {};
  data.meta = {
    os:   Array.isArray(meta.os)   && meta.os.length   ? meta.os   : FALLBACK_META.os.map(x => x.value),
    vcpu: Array.isArray(meta.vcpu) && meta.vcpu.length ? meta.vcpu : FALLBACK_META.vcpu,
    ram:  Array.isArray(meta.ram)  && meta.ram.length  ? meta.ram  : FALLBACK_META.ram
  };

  return data;
}
