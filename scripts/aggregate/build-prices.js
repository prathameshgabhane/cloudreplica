/* scripts/aggregate/build-prices.js
 * Merge provider JSONs (AWS/Azure/GCP) into a FLAT prices.json:
 *   { meta, azure:[], aws:[], gcp:[], generatedAt }
 *
 * Usage (local):
 *   node scripts/aggregate/build-prices.js
 *   node scripts/aggregate/build-prices.js --out docs/data/prices.json
 */

const fs = require("fs");
const path = require("path");

// ---------- Paths ----------
const BASE = path.resolve(__dirname, "..", "..");
const AWS_FILE   = path.join(BASE, "data", "aws",   "aws.prices.json");
const AZURE_FILE = path.join(BASE, "data", "azure", "azure.prices.json");
const GCP_FILE   = path.join(BASE, "data", "gcp",   "gcp.prices.json");

// --out <file> (optional) → defaults to data/prices.json
const ARG_OUT_IDX = process.argv.indexOf("--out");
const OUTPUT_FILE = ARG_OUT_IDX > -1 && process.argv[ARG_OUT_IDX + 1]
  ? path.resolve(process.argv[ARG_OUT_IDX + 1])
  : path.join(BASE, "data", "prices.json");

// ---------- Helpers ----------
function bytesOf(str) {
  return Buffer.byteLength(String(str ?? ""), "utf8");
}

function loadJSON(filePath, { required = true } = {}) {
  const pretty = path.relative(BASE, filePath);
  if (!fs.existsSync(filePath)) {
    const msg = `⚠ Missing file: ${pretty}`;
    if (required) console.error(msg); else console.warn(msg);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    console.log(`↳ Loaded ${pretty} (${bytesOf(raw)} bytes)`);
    return obj;
  } catch (err) {
    console.error(`❌ JSON parse error in ${pretty}: ${err.message}`);
    return null;
  }
}

function isFiniteNum(n) {
  return Number.isFinite(n);
}

function uniqSortedNums(arr) {
  return [...new Set((arr || []).filter(isFiniteNum))].sort((a, b) => a - b);
}

function mergeMeta(a = {}, b = {}) {
  const os   = [...new Set([...(a.os || []), ...(b.os || [])])];
  const vcpu = uniqSortedNums([...(a.vcpu || []), ...(b.vcpu || [])]);
  const ram  = uniqSortedNums([...(a.ram  || []), ...(b.ram  || [])]);
  return { os, vcpu, ram };
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function asComputeArray(providerObj) {
  // Provider files your fetchers write: { meta:{...}, compute:[...] }
  const arr = Array.isArray(providerObj?.compute) ? providerObj.compute : [];
  return arr;
}

function summarize(label, obj) {
  const count = Array.isArray(obj?.compute) ? obj.compute.length : 0;
  const m = obj?.meta || {};
  console.log(
    `• ${label}: compute=${count} meta{` +
    ` os=${Array.isArray(m.os) ? m.os.length : 0},` +
    ` vcpu=${Array.isArray(m.vcpu) ? m.vcpu.length : 0},` +
    ` ram=${Array.isArray(m.ram) ? m.ram.length : 0} }`
  );
}

// ---------- Main ----------
(function main() {
  console.log("== Aggregate provider files → FLAT prices.json ==");

  const aws   = loadJSON(AWS_FILE,   { required: false });
  const azure = loadJSON(AZURE_FILE, { required: false });
  const gcp   = loadJSON(GCP_FILE,   { required: false });

  if (!aws && !azure && !gcp) {
    console.error("❌ No provider files found; aborting.");
    process.exit(1);
  }

  console.log("== Provider summaries ==");
  summarize("AWS",   aws);
  summarize("Azure", azure);
  summarize("GCP",   gcp);

  // Merge meta from whichever providers are present
  let meta = { os: [], vcpu: [], ram: [] };
  if (aws?.meta)   meta = mergeMeta(meta, aws.meta);
  if (azure?.meta) meta = mergeMeta(meta, azure.meta);
  if (gcp?.meta)   meta = mergeMeta(meta, gcp.meta);

  // Flat arrays
  const flat = {
    meta,
    azure: asComputeArray(azure),
    aws:   asComputeArray(aws),
    gcp:   asComputeArray(gcp),
    generatedAt: new Date().toISOString()
  };

  // Warn if any array is empty (helps catch accidental empties)
  if (flat.aws.length === 0)   console.warn("⚠ AWS compute array is empty");
  if (flat.azure.length === 0) console.warn("⚠ Azure compute array is empty");
  if (flat.gcp.length === 0)   console.warn("⚠ GCP compute array is empty");

  ensureDirFor(OUTPUT_FILE);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(flat, null, 2), "utf8");
  console.log(`✅ Aggregated → ${path.relative(BASE, OUTPUT_FILE)}`);
})();
