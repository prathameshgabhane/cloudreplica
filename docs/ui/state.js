// docs/ui/state.js
export const API_BASE = "./data/prices.json";

// Defaults for dropdown meta
export const FALLBACK_META = {
  os:   [{ value: "Linux" }, { value: "Windows" }],
  vcpu: [1, 2, 4, 8, 16],
  ram:  [1, 2, 4, 8, 16, 32]
};

// In-memory storage pricing defaults (overridden by prices.json when present)
export let STORAGE_CFG = {
  aws:  { region: "us-east-1", ssd_per_gb_month: 0.08, hdd_st1_per_gb_month: 0.045 },
  azure:{ region: "eastus",
          ssd_monthly: {4:0.3,8:0.6,16:1.2,32:2.4,64:4.8,128:9.6,256:19.2,512:38.4},
          hdd_monthly: {32:1.536,64:3.008,128:5.888,256:11.328} }
};

export async function loadPricesAndMeta() {
  const r = await fetch(API_BASE, { mode: "cors" });
  if (!r.ok) throw new Error(`Failed to read ${API_BASE}`);
  const data = await r.json();

  if (data.storage?.aws || data.storage?.azure) {
    STORAGE_CFG = {
      aws: {
        region: data.storage?.aws?.region ?? STORAGE_CFG.aws.region,
        ssd_per_gb_month: Number(data.storage?.aws?.ssd_per_gb_month ?? STORAGE_CFG.aws.ssd_per_gb_month),
        hdd_st1_per_gb_month: Number(data.storage?.aws?.hdd_st1_per_gb_month ?? STORAGE_CFG.aws.hdd_st1_per_gb_month),
      },
      azure: {
        region: data.storage?.azure?.region ?? STORAGE_CFG.azure.region,
        ssd_monthly: data.storage?.azure?.ssd_monthly ?? STORAGE_CFG.azure.ssd_monthly,
        hdd_monthly: data.storage?.azure?.hdd_monthly ?? STORAGE_CFG.azure.hdd_monthly,
      }
    };
  }

  return data;
}
