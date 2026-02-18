// scripts/lib/gcp.js
"use strict";

/**
 * Compute Engine service id for Catalog API (public SKUs).
 * Example: services/6F81-5844-456A
 */
const CE_SERVICE_ID = "6F81-5844-456A";

/* ============================================================
 * Apples-to-apples family policy across clouds
 * ------------------------------------------------------------
 *  GENERAL  ↔ AWS(M/T), Azure(D)     → GCP: E/N/T series (STANDARD only)
 *  COMPUTE  ↔ AWS(C),    Azure(F)    → GCP: C-series + any *-HIGHCPU-*
 *  MEMORY   ↔ AWS(R),    Azure(E)    → GCP: M-series + any *-HIGHMEM-*
 * ============================================================ */

const GCP_SERIES_ALLOW = {
  general: ["E2", "N1", "N2", "N2D", "N4", "N4A", "N4D", "T2A", "T2D"],
  // Add H4 (in addition to H3/H4D) for forward compatibility
  compute: ["C2", "C2D", "C3", "C3D", "C4", "C4D", "C4A", "H3", "H4", "H4D"],
  // Add X4 (bare-metal memory-optimized)
  memory:  ["M1", "M2", "M3", "M4", "X4"]
};

// IMPORTANT: Do NOT map STANDARD here. We decide STANDARD by series.
const CLASS_TO_CATEGORY = {
  HIGHCPU:  "compute",
  HIGHMEM:  "memory",
  ULTRAMEM: "memory",
  MEGAMEM:  "memory"
};

const GCP_EXAMPLE_INSTANCES = {
  general: ["e2-standard-2", "n2-standard-4", "t2a-standard-4", "n4-standard-4"],
  compute: ["c2-standard-4", "c3-standard-4", "c4-standard-4", "n2-highcpu-4", "e2-highcpu-8"],
  memory:  ["m1-ultramem-40", "m2-ultramem-208", "m3-megamem-64", "n2-highmem-8", "e2-highmem-4"]
};

/* ---------------------------
 * Classification & parsing
 * --------------------------- */

function inferMachineType(sku) {
  const attrs = sku?.attributes || {};
  if (attrs.machineType) {
    const mt = String(attrs.machineType).toLowerCase();
    if (/^custom-/.test(mt)) return null; // exclude custom
    return mt;
  }
  const s = String(sku?.description || sku?.displayName || "").toLowerCase();
  // Expanded to include x4, h3, h4, h4d
  const re = /\b(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)\b/;
  const m = s.match(re);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`; // predefined only
}

function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const unit = p?.pricingExpression?.tieredRates?.[0]?.unitPrice;
    if (!unit) continue;
    const price = Number(unit.units || 0) + Number(unit.nanos || 0) / 1e9;
    if (price > 0) return price;
  }
  return null;
}

function deriveVcpuRamFromType(mt) {
  if (!mt) return { vcpu: undefined, ram: undefined };
  if (/^custom-/.test(mt)) return { vcpu: undefined, ram: undefined }; // exclude custom
  // Expanded to include x4, h3, h4, h4d
  const m = mt.match(/^(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)$/i);
  if (!m) return { vcpu: undefined, ram: undefined };
  const series = m[1].toLowerCase();
  const cls = m[2].toLowerCase();
  const vcpu = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };
  if (series.startsWith("m") || series.startsWith("x")) return { vcpu, ram: undefined }; // do not guess for M/X
  if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 4 };
  if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 8 };
  if (cls.startsWith("highcpu"))  return { vcpu, ram: series.startsWith("n1") ? vcpu * 0.9 : vcpu * 1.0 };
  return { vcpu, ram: undefined };
}

function regionMatches(serviceRegions, region) {
  const want = String(region || "").toLowerCase();
  const set = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  if (set.has(want)) return true;
  if (set.has("global")) return true;
  if (want.startsWith("us-") && set.has("us")) return true;
  return false;
}

function isPerInstanceSku(sku, machineType) {
  const name = String(sku?.description || sku?.displayName || "");
  if (!machineType) return false;
  if (/^custom-/.test(machineType)) return false; // exclude custom
  if (/\b(Core|vCPU|Ram|Memory|Sole\s*Tenancy|Sole\s*Tenant)\b/i.test(name)) return false; // unit or ST
  const hasInstanceNoun = /\b(Instance|VM)\b/i.test(name);
  const includesType = name.toLowerCase().includes(String(machineType).toLowerCase());
  return hasInstanceNoun && includesType;
}

/**
 * Parse Catalog SKUs into { series: { core, ram } } map (Linux unit rates).
 * IMPORTANT: Do NOT require "instance|vm" — M-series unit SKUs often omit those words.
 */
function parseSeriesUnitRate(sku) {
  const name = (sku.description || sku.displayName || "").toLowerCase();
  if (/windows.*license|license.*windows/i.test(name)) return null;

  // Expanded series list with x4, h3, h4, h4d
  const m = name.match(
    /\b(m1|m2|m3|m4|x4|h4d|h4|h3|n1|n2d|n2|n4|e2|t2a|t2d|c2d|c3d|c3|c4d|c4|c4a|c2)\b.*\b(core|vcpu|ram|memory|ultramem|megamem)\b/i
  );
  if (!m) return null;

  const series = m[1].toLowerCase();
  const kindRaw = m[2].toLowerCase();
  const kind = /(ram|memory|ultramem|megamem)/.test(kindRaw) ? "ram" : "core";

  const price = extractHourlyPrice(sku.pricingInfo);
  if (!(price > 0)) return null;
  return { series, kind, price };
}

function buildSeriesUnitRateMaps(allSkus, region) {
  const maps = {};
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

/**
 * Find the Windows Server on‑demand license rate PER vCPU for the given region
 * by scanning the Cloud Billing Catalog SKUs you already fetched.
 * Returns a Number (USD per vCPU‑hour) or null if not found.
 *
 * Strategy:
 *  - Pass 1 (strict): require windows + (license|licensing|core|vcpu), exclude obvious non-candidates.
 *  - Pass 2 (relaxed): accept "paid/on‑demand/windows server" phrasing like the Console UI if strict finds nothing.
 *  - If multiple, pick the lowest positive price defensively.
 *  - If GCP_DEBUG_WIN=1, print a sample of candidates for diagnostics.
 */
function buildWindowsCoreRate(allSkus, region) {
  const inRegion = (sku) => {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") return false;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return false;
    return regionMatches(sku.serviceRegions, region);
  };

  // Exclusions that are never the Windows Server license core SKU
  const BAD = /(ram|memory|gpu|sole\s*tenan|local ssd|persistent disk|commitment|spot|preemptible|sles|rhel|sql)/i;

  const candidates = [];

  // Pass 1: strict
  for (const sku of allSkus) {
    if (!inRegion(sku)) continue;
    const name = (sku.description || sku.displayName || "").toLowerCase();
    if (!/windows/.test(name)) continue;
    if (!/(license|licensing|core|vcpu)/.test(name)) continue;
    if (BAD.test(name)) continue;

    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name, sku });
  }

  // Pass 2: relaxed
  if (candidates.length === 0) {
    for (const sku of allSkus) {
      if (!inRegion(sku)) continue;
      const name = (sku.description || sku.displayName || "").toLowerCase();
      if (!/windows/.test(name)) continue;
      if (BAD.test(name)) continue;

      // Phrases commonly seen in UI / catalog variants
      if (!/(paid|on-?demand|windows\s*server)/.test(name)) continue;

      const price = extractHourlyPrice(sku.pricingInfo);
      if (price && price > 0) candidates.push({ price, name, sku });
    }
  }

  if (process.env.GCP_DEBUG_WIN === "1") {
    const sample = candidates
      .slice(0, 10)
      .map(c => ({ price: c.price, name: c.name }))
      .sort((a, b) => a.price - b.price);
    console.log("[GCP][WIN] candidate SKUs (sample):", JSON.stringify(sample, null, 2));
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.price - b.price);
  return candidates[0].price;
}

function classifyGcpInstance(instance) {
  if (!instance) return null;
  const raw = String(instance);
  if (/^custom-/i.test(raw)) return null; // exclude custom
  const tok = raw.toUpperCase().replace(/-/g, "_");
  const m = tok.match(/^([A-Z0-9]+)_(STANDARD|HIGHCPU|HIGHMEM|ULTRAMEM|MEGAMEM)_(\d+)$/);
  if (!m) return null;
  const series = m[1];
  const cls = m[2];

  // Precedence ONLY for non-standard classes
  if (cls === "HIGHCPU") return "compute";
  if (cls === "HIGHMEM" || cls === "ULTRAMEM" || cls === "MEGAMEM") return "memory";

  // STANDARD → decide by series (C→compute, M/X→memory, E/N/T→general)
  if (GCP_SERIES_ALLOW.compute.includes(series)) return "compute";
  if (GCP_SERIES_ALLOW.memory.includes(series))  return "memory";
  if (GCP_SERIES_ALLOW.general.includes(series)) return "general";
  return null;
}

function getGcpAllowedPrefixes(category) {
  return (GCP_SERIES_ALLOW[category] || []).map(s => s.toUpperCase());
}

/* FULL-mode helpers (Compute API via OIDC) */
async function getAccessTokenFromADC() {
  const token =
    process.env.GCLOUD_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  if (!token) {
    throw new Error(
      "[GCP] No access token found in env. Ensure your workflow passes steps.auth.outputs.access_token to GCLOUD_ACCESS_TOKEN."
    );
  }
  return token;
}

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
      const name = String(z.name || "").toLowerCase();
      if (name.startsWith(`${region.toLowerCase()}-`)) zones.push(z.name);
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return zones;
}

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
      if (/^custom-/i.test(name)) continue; // exclude custom
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name)) continue; // predefined shapes only
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
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
  GCP_EXAMPLE_INSTANCES,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps,
  buildWindowsCoreRate
};
