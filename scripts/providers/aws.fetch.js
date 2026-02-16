// scripts/providers/aws.fetch.js
// Node 18+ (global fetch)

const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");
const { isWantedEc2Family } = require("../lib/aws");

const REGION = process.env.AWS_REGION || "us-east-1";
const OUT = path.join("data", "aws", "aws.prices.json");

/**
 * Fetch the regional EC2 public price index JSON.
 * Doc note: EC2 publishes a region-specific index at:
 * https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/<REGION>/index.json
 */
async function fetchAwsIndex() {
  logStart(`[AWS] EC2 PAYG ${REGION}`);
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${REGION}/index.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[AWS] Pricing HTTP ${r.status}`);
  const j = await r.json();
  logDone(`[AWS] products=${Object.keys(j.products || {}).length}`);
  return j;
}

/**
 * Pick the first OnDemand price dimension that is hourly and in USD.
 */
function pickHourlyUsd(onDemandTermsForSku) {
  if (!onDemandTermsForSku) return null;
  const termKey = Object.keys(onDemandTermsForSku)[0];
  if (!termKey) return null;
  const dims = onDemandTermsForSku[termKey]?.priceDimensions || {};
  for (const dimKey of Object.keys(dims)) {
    const dim = dims[dimKey];
    // Expect unit "Hrs" (or "Hrs ") and USD price present
    if (dim?.unit?.toLowerCase().startsWith("hrs") && dim?.pricePerUnit?.USD) {
      const price = Number(dim.pricePerUnit.USD);
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return null;
}

/**
 * Normalize memory string to Number GiB.
 * Examples: "16 GiB", "32GiB", "64 GiB  "
 */
function parseGiB(memStr) {
  if (!memStr) return null;
  const n = Number(String(memStr).replace(/[^0-9.]/g, "")); // keep digits + dot
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const j = await fetchAwsIndex();

  const products = j.products || {};
  const onDemandTerms = (j.terms && j.terms.OnDemand) || {};

  const rows = [];
  for (const sku in products) {
    const p = products[sku];
    if (!p || p.productFamily !== "Compute Instance") continue;

    const a = p.attributes || {};
    const inst = a.instanceType;
    if (!inst || !isWantedEc2Family(inst)) continue;

    const os = a.operatingSystem;
    if (os !== "Linux" && os !== "Windows") continue;
    if (a.tenancy !== "Shared") continue;
    if (!["Used", "Normal"].includes(a.capacitystatus)) continue;

    const price = pickHourlyUsd(onDemandTerms[sku]);
    if (!(price > 0)) continue;

    const vcpu = a.vcpu ? Number(a.vcpu) : null;
    const ram = parseGiB(a.memory);

    rows.push({
      instance: inst,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region: REGION,
      os
    });
  }

  // Keep the cheapest per (instance, region, OS)
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  console.log(`[AWS] collected=${rows.length}, cheapest=${cheapest.length}`);
  if (warnAndSkipWriteOnEmpty("AWS", cheapest)) return;

  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    // Small constants; replace with a real fetcher if/when you want EBS by volume type
    ssd_per_gb_month: 0.08,     // gp3 ballpark
    hdd_st1_per_gb_month: 0.045 // st1
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
