// scripts/lib/gcp.js
"use strict";

/**
 * Compute Engine service id for Catalog API (public SKUs).
 * Example from docs: services/6F81-5844-456A
 */
const CE_SERVICE_ID = "6F81-5844-456A";

/* ---------------------------
 * Classification & parsing
 * --------------------------- */

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

/**
 * Extract hourly price from Catalog pricingInfo.tieredRates[].unitPrice
 */
function extractHourlyPrice(pricingInfo) {
  for (const p of pricingInfo || []) {
    const expr = p?.pricingExpression;
    const unit = expr?.tieredRates?.[0]?.unitPrice;
    if (!unit) continue;
    const price = Number(unit.units || 0) + Number(unit.nanos || 0) / 1e9;
    if (price > 0) return price;
  }
  return null;
}

/**
 * Infer machine type token (e.g., "n2-standard-4") from attributes or displayName.
 */
function inferMachineType(sku) {
  const attrs = sku?.attributes || {};
  if (attrs.machineType) return String(attrs.machineType).toLowerCase();

  const s = String(sku?.displayName || "").toLowerCase();
  const m = s.match(
    /\b([a-z0-9]+-(?:standard|highmem|highcpu|ultramem|megamem|c2d|c3|c4|c3d|c4d|c4a|n1|n2|n2d|n4|t2a|t2d|e2)-\d+)\b/
  );
  return m ? m[1] : null;
}

/**
 * Conservative vCPU/RAM derivation for predefined families when attributes missing.
 */
function deriveVcpuRamFromType(mt) {
  if (!mt) return { vcpu: undefined, ram: undefined };
  const m = mt.match(/^([a-z0-9]+)-([a-z]+[a-z0-9]*)-(\d+)$/);
  if (!m) return { vcpu: undefined, ram: undefined };
  const series = m[1];
  const cls    = m[2];
  const vcpu   = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };

  if (series.startsWith("n1")) {
    if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 3.75 };
    if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 6.5  };
    if (cls.startsWith("highcpu"))  return { vcpu, ram: vcpu * 0.9  };
  }
  if (
    series.startsWith("n2")  || series.startsWith("n2d") ||
    series.startsWith("e2")  || series.startsWith("t2a") ||
    series.startsWith("t2d") || series.startsWith("n4")  ||
    series.startsWith("c3")  || series.startsWith("c4")
  ) {
    if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 4 };
    if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 8 };
    if (cls.startsWith("highcpu"))  return { vcpu, ram: vcpu * 2 };
  }
  if (series.startsWith("c2")) return { vcpu, ram: vcpu * 4 };

  return { vcpu: undefined, ram: undefined };
}

/**
 * Region matching for Catalog SKUs: exact, 'global', and optional 'us' super‑region.
 */
function regionMatches(serviceRegions, region) {
  const want = String(region || "").toLowerCase();
  const set  = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  if (set.has(want)) return true;
  if (set.has("global")) return true;
  if (want.startsWith("us-") && set.has("us")) return true;
  return false;
}

/**
 * Identify real per‑instance SKUs and exclude unit SKUs (Core/Ram)
 * and Sole‑Tenancy surcharges.
 */
function isPerInstanceSku(sku, machineType) {
  const name = String(sku?.displayName || "");
  if (!machineType) return false;
  if (/\b(Core|Ram|Sole\s*Tenancy|Sole\s*Tenant)\b/i.test(name)) return false;
  const hasInstanceVerb = /\bInstance\b|\brunning\b/i.test(name);
  const includesType    = name.toLowerCase().includes(String(machineType).toLowerCase());
  return hasInstanceVerb && includesType;
}

/* ---------------------------
 * Category → GCP family allow‑list (for recommendations)
 * --------------------------- */
const gcpFamilyAllowList = {
  general: [ "t2d", "n2d", "e2", "n2", "n4" ],
  compute: [ "c3d", "c3", "c2", "c4" ],
  memory:  [ "m4", "m3", "m2", "m1" ]
};
function getGcpAllowedPrefixes(category) {
  return (gcpFamilyAllowList[category] || []).map(s => s.toUpperCase());
}

/* ---------------------------
 * FULL‑mode helpers (Compute API via OIDC)
 * No SDKs — read short‑lived token from env (GCLOUD_ACCESS_TOKEN)
 * --------------------------- */

/**
 * Get short‑lived access token issued by the OIDC workflow step.
 * Ensure your workflow exports it as GCLOUD_ACCESS_TOKEN.
 */
async function getAccessTokenFromADC() {
  const token =
    process.env.GCLOUD_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN || // optional fallback
    "";
  if (!token) {
    throw new Error(
      "[GCP] No access token found in env. " +
      "Ensure your workflow passes steps.auth.outputs.access_token to GCLOUD_ACCESS_TOKEN."
    );
  }
  return token;
}

// List project zones, filtered to the chosen region prefix (e.g., "us-east1-")
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

// List machineTypes for a zone; exclude custom; keep name/guestCpus/memoryMb
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
      if (/^custom-/.test(name)) continue;
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name)) continue; // predefined shapes only
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
}

/**
 * Parse Catalog SKUs into a { series: { core: rate, ram: rate } } map for Linux.
 * Reads "N2 Instance Core running..." and "N2 Instance Ram running..." SKUs.
 */
function parseSeriesUnitRate(sku) {
  const name = (sku.displayName || "").toLowerCase();
  if (/windows|license/i.test(name)) return null;
  const m = name.match(/\b(n1|n2d|n2|n4|e2|t2a|t2d|c2d|c3d|c3|c4d|c4|c4a|c2)\b.*\binstance\s+(core|ram)\b/i);
  if (!m) return null;
  const series = m[1].toLowerCase();
  const kind   = m[2].toLowerCase();
  const price  = extractHourlyPrice(sku.pricingInfo);
  if (!(price > 0)) return null;
  return { series, kind, price };
}

function buildSeriesUnitRateMaps(allSkus, region) {
  const maps = {}; // { series: { core, ram } }
  for (const sku of allSkus) {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;
    if (!regionMatches(sku.serviceRegions, region)) continue;
    const info = parseSeriesUnitRate(sku);
    if (!info) continue;
    if (!maps[info.series]) maps[info.series] = {};
    maps[info.series][info.kind] = info.price;
  }
  return maps;
}

module.exports = {
  CE_SERVICE_ID,
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  getGcpAllowedPrefixes,
  // FULL-mode exports
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps
};
