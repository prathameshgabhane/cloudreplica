// scripts/aggregate/build-prices.js
const fs = require("fs");
const path = require("path");
const { atomicWrite, uniqSortedNums } = require("../lib/common");

function readIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function aggregate() {
  const providers = ["aws", "azure", "gcp", "oci"];
  const root = "data";

  const agg = {
    meta: { os: [], vcpu: [], ram: [] },
    storage: {}
  };

  for (const p of providers) {
    const f = path.join(root, p, "prices.json");
    const j = readIfExists(f);
    if (!j) continue;

    // meta union
    agg.meta.os = Array.from(new Set([...(agg.meta.os||[]), ...((j.meta && j.meta.os) || [])]));
    agg.meta.vcpu = uniqSortedNums([...(agg.meta.vcpu||[]), ...(((j.meta && j.meta.vcpu) || []))]);
    agg.meta.ram  = uniqSortedNums([...(agg.meta.ram ||[]), ...(((j.meta && j.meta.ram ) || []))]);

    // compute
    agg[p] = Array.isArray(j.compute) ? j.compute : [];

    // storage (per provider)
    if (j.storage) agg.storage[p] = j.storage;
  }

  // If no providers present, keep meta minimal to avoid UI crash
  if (!agg.aws && !agg.azure && !agg.gcp && !agg.oci) {
    agg.meta.os = agg.meta.os.length ? agg.meta.os : ["Linux","Windows"];
  }

  return agg;
}

function main() {
  const out = aggregate();
  const OUT = path.join("data", "prices.json");
  atomicWrite(OUT, out);
  console.log(`✅ Aggregated → ${OUT}`);
}

main();
