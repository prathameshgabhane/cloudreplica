// scripts/lib/oci.js
"use strict";

const crypto = require("crypto");

/** Region (matches OCI's identifiers like us-ashburn-1) */
const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";

/** Public pricing JSON endpoints (override via env if needed) */
const OCI_BLOCK_PRICING_URL =
  process.env.OCI_BLOCK_PRICING_URL ||
  "https://docs.oracle.com/en-us/iaas/pricing/block-volume.json";

const OCI_COMPUTE_PRICING_URL =
  process.env.OCI_COMPUTE_PRICING_URL ||
  "https://docs.oracle.com/en-us/iaas/pricing/compute.json";

/** 1 OCPU = 2 vCPUs (for later compute normalization) */
function ocpuToVcpu(ocpus) {
  const n = Number(ocpus);
  if (!Number.isFinite(n)) return undefined;
  return n * 2;
}

/** Fetch OCI Block Volume pricing JSON (public) */
async function fetchOciBlockVolumePricing() {
  const r = await fetch(OCI_BLOCK_PRICING_URL, { method: "GET" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[OCI] block-volume pricing HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

/**
 * Extract SSD (Balanced) & HDD (Standard) $/GB-month for a region.
 * Returns { ssd, hdd } or throws if not found.
 */
function pickStoragePricesForRegion(blockJson, region) {
  if (!blockJson || typeof blockJson !== "object" || !blockJson.regions) {
    throw new Error("[OCI] block-volume pricing JSON is missing 'regions'.");
  }
  const reg = blockJson.regions[region];
  if (!reg) {
    const known = Object.keys(blockJson.regions || {}).slice(0, 6);
    throw new Error(`[OCI] Region '${region}' not in block-volume pricing. Known sample: ${known.join(", ")} ...`);
  }

  // Common keys seen in OCI pricing feeds:
  //  - BlockVolume.Balanced.storage → SSD-equivalent (Balanced)
  //  - BlockVolume.Standard.storage → HDD-equivalent (Standard)
  const balanced = reg["BlockVolume.Balanced"] || reg["balanced"] || reg["BALANCED"];
  const standard = reg["BlockVolume.Standard"] || reg["standard"] || reg["STANDARD"];

  const ssd = Number(balanced?.storage);
  const hdd = Number(standard?.storage);

  if (!Number.isFinite(ssd) || !Number.isFinite(hdd)) {
    const dump = JSON.stringify(reg, null, 2).slice(0, 400);
    throw new Error(`[OCI] Could not resolve Balanced/Standard storage prices in '${region}'. Region entry:\n${dump}`);
  }
  return { ssd, hdd };
}

/* ---------- Placeholders for Step 2 (Compute) ---------- */

/**
 * Minimal signer stub for OCI REST (we'll wire this in Step 2).
 * For now we keep it here so imports don't change later.
 */
async function signedFetch(url, opts = {}) {
  // In Step 2 we'll sign requests to call /20160918/shapes, etc.
  // For storage we don't need signing, so just throw if used.
  throw new Error("[OCI] signedFetch is not implemented yet (we'll add it when we integrate compute).");
}

/**
 * Simple classification stub for OCI shapes (we'll use this in Step 2):
 *  - DenseIO ⇒ memory
 *  - E* family / high-cpu shapes ⇒ compute
 *  - High RAM per OCPU ⇒ memory
 *  - otherwise ⇒ general
 */
function classifyOciShape(shapeName, ocpus, memoryGb) {
  if (!shapeName) return null;
  const name = String(shapeName);
  const ratio = Number(memoryGb) / Number(ocpus || 1);
  if (/DenseIO/i.test(name)) return "memory";
  if (/\.E\d/i.test(name)) return "compute";
  if (Number.isFinite(ratio) && ratio >= 8) return "memory";
  return "general";
}

module.exports = {
  OCI_REGION,
  OCI_BLOCK_PRICING_URL,
  OCI_COMPUTE_PRICING_URL,
  fetchOciBlockVolumePricing,
  pickStoragePricesForRegion,
  ocpuToVcpu,
  classifyOciShape,
  signedFetch // will be used in Step 2
};
