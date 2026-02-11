// scripts/aggregate/build-prices.js
const fs = require("fs");
const path = require("path");

// FIXED PATHS – these folders exist because the fetchers write here
const AWS_FILE = path.join(__dirname, "..", "data", "aws", "aws.prices.json");
const AZURE_FILE = path.join(__dirname, "..", "data", "azure", "azure.prices.json");

// Output file
const OUTPUT_FILE = path.join(__dirname, "..", "data", "prices.json");

// Load JSON safely
function loadJSON(f) {
  if (!fs.existsSync(f)) {
    console.error(`❌ Missing file: ${f}`);
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
    vcpu: Array.from(new Set([...(a.vcpu || []), ...(b.vcpu || [])])).sort(
      (x, y) => x - y
    ),
    ram: Array.from(new Set([...(a.ram || []), ...(b.ram || [])])).sort(
      (x, y) => x - y
    )
  };
}

// MAIN
function main() {
  const aws = loadJSON(AWS_FILE);
  const azure = loadJSON(AZURE_FILE);

  if (!aws || !azure) {
    console.error("❌ Provider files missing — aggregator cannot run");
    process.exit(1);
  }

  const final = {
    meta: mergeMeta(aws.meta, azure.meta),
    aws: aws.compute || [],
    azure: azure.compute || [],
    generatedAt: new Date().toISOString()
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(final, null, 2));
  console.log("✅ Aggregated → data/prices.json");
}

main();
