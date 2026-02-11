// scripts/aggregate/build-prices.js
const fs = require("fs");
const path = require("path");

// FIXED CORRECT PATHS – two levels up from scripts/aggregate/
const AWS_FILE   = path.join(__dirname, "..", "..", "data", "aws", "aws.prices.json");
const AZURE_FILE = path.join(__dirname, "..", "..", "data", "azure", "azure.prices.json");
const GCP_FILE   = path.join(__dirname, "..", "..", "data", "gcp", "gcp.prices.json");

// Output file
const OUTPUT_FILE = path.join(__dirname, "..", "..", "data", "prices.json");

// Load JSON safely
function loadJSON(f) {
  if (!fs.existsSync(f)) {
    console.warn(`⚠ Missing file: ${f}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (err) {
    console.error(`❌ JSON parse error in ${f}:`, err.message);
    return null;
  }
}

// Merge meta fields (os, vcpu, ram)
function mergeMeta(a, b) {
  return {
    os: Array.from(new Set([...(a.os || []), ...(b.os || [])])),
    vcpu: Array.from(new Set([...(a.vcpu || []), ...(b.vcpu || [])])).sort((x, y) => x - y),
    ram:  Array.from(new Set([...(a.ram  || []), ...(b.ram  || [])])).sort((x, y) => x - y)
  };
}

// MAIN
function main() {
  const aws   = loadJSON(AWS_FILE);
  const azure = loadJSON(AZURE_FILE);
  const gcp   = loadJSON(GCP_FILE); // NEW (optional)

  if (!aws || !azure) {
    console.error("❌ AWS or Azure files missing — aggregator cannot run");
    process.exit(1);
  }

  // Start meta merge with AWS + Azure
  let meta = mergeMeta(aws.meta, azure.meta);

  // If GCP exists, merge its meta too
  if (gcp && gcp.meta) {
    meta = mergeMeta(meta, gcp.meta);
  } else {
    console.warn("⚠ GCP file missing or invalid — continuing without GCP");
  }

  const final = {
    meta,
    aws:   aws.compute   || [],
    azure: azure.compute || [],
    gcp:   gcp?.compute  || [],   // NEW
    generatedAt: new Date().toISOString()
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(final, null, 2));
  console.log("✅ Aggregated → data/prices.json");
}

main();
