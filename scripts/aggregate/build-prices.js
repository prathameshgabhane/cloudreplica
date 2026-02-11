// scripts/aggregate/build-prices.js
const fs = require("fs");
const path = require("path");
const { atomicWrite, uniqSortedNums } = require("../lib/common");

function readIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`⚠️ Failed to parse JSON: ${file} -> ${e.message}`);
    return null;
  }
}

function aggregate() {
  const providers = ["aws", "azure", "gcp", "oci"];
  const root = "data";

  const agg = {
    meta: { os: [], vcpu: [], ram: [] },
    storage: {}
  };

  const seen = { aws: false, azure: false, gcp: false, oci: false };

  for (const p of providers) {
    // Use new file names for AWS/Azure; keep generic default for others
    const f =
      p === "aws"
        ? path.join(root, "aws", "aws.prices.json")
        : p === "azure"
        ? path.join(root, "azure", "azure.prices.json")
        : path.join(root, p, "prices.json");

    const j = readIfExists(f);
    if (!j) {
      console.log(`ℹ️ ${p.toUpperCase()} file not found or empty: ${f}`);
      continue;
    }

    seen[p] = true;

    // ---- meta union ----
    const srcMeta = j.meta || {};
    agg.meta.os = Array.from(new Set([...(agg.meta.os || []), ...(srcMeta.os || [])]));
    agg.meta.vcpu = uniqSortedNums([...(agg.meta.vcpu || []), ...(srcMeta.vcpu || [])]);
    agg.meta.ram = uniqSortedNums([...(agg.meta.ram || []), ...(srcMeta.ram || [])]);

    // ---- compute list per provider ----
    const compute = Array.isArray(j.compute) ? j.compute : [];
    console.log(`✅ ${p.toUpperCase()} rows: ${compute.length}`);
    agg[p] = compute;

    // ---- storage (per provider) ----
    if (j.storage) agg.storage[p] = j.storage;
  }

  // If no providers present, keep meta minimal to avoid UI crash
  if (!agg.aws && !agg.azure && !agg.gcp && !agg.oci) {
    agg.meta.os = agg.meta.os.length ? agg.meta.os : ["Linux", "Windows"];
  }

  // Also: if we didn't see ANY provider files, let the workflow fail loudly
  if (!seen.aws && !seen.azure && !seen.gcp && !seen.oci) {
    throw new Error(
      "No provider inputs found. Expected at least one of:\n" +
      " - data/aws/aws.prices.json\n" +
      " - data/azure/azure.prices.json\n" +
      " - data/gcp/prices.json\n" +
      " - data/oci/prices.json"
    );
  }

  return agg;
}

function main() {
  const out = aggregate();
  const OUT = path.join("data", "prices.json");
  atomicWrite(OUT, out);
  console.log(`🟢 Aggregated → ${OUT}`);
}

main();
