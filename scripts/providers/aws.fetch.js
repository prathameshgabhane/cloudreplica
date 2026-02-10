// scripts/providers/aws.fetch.js
// Node 18+ (global fetch)
const path = require("path");
const { atomicWrite, dedupeCheapestByKey, warnAndSkipWriteOnEmpty, logStart, logDone, uniqSortedNums } = require("../lib/common");
const { isWantedEc2Family } = require("../lib/aws");

const REGION = process.env.AWS_REGION || "us-east-1";
const OUT = path.join("data", "aws", "aws.prices.json");

async function fetchAwsIndex() {
  logStart(`[AWS] EC2 PAYG ${REGION}`);
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${REGION}/index.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[AWS] Pricing HTTP ${r.status}`);
  const j = await r.json();
  logDone(`[AWS] products=${Object.keys(j.products||{}).length}`);
  return j;
}

async function main() {
  const j = await fetchAwsIndex();
  const products = j.products || {};
  const onDemand = (j.terms && j.terms.OnDemand) || {};

  const rows = [];
  for (const sku in products) {
    const p = products[sku];
    if (!p || p.productFamily !== "Compute Instance") continue;
    const a = p.attributes || {};
    const inst = a.instanceType;
    if (!inst || !isWantedEc2Family(inst)) continue;

    const os = a.operatingSystem;
    if (!["Linux", "Windows"].includes(os)) continue;
    if (a.tenancy !== "Shared") continue;
    if (!["Used","Normal"].includes(a.capacitystatus)) continue;

    const t = onDemand[sku];
    const tKey = t ? Object.keys(t)[0] : null;
    const dims = tKey ? t[tKey].priceDimensions : null;
    const dKey = dims ? Object.keys(dims)[0] : null;
    const dim = dKey ? dims[dKey] : null;
    const price = Number(dim?.pricePerUnit?.USD);
    if (!Number.isFinite(price) || price <= 0) continue;

    const vcpu = a.vcpu ? Number(a.vcpu) : null;
    const ram  = a.memory ? Number(String(a.memory).replace(/ GiB/i,"")) : null;

    rows.push({ instance: inst, vcpu, ram, pricePerHourUSD: price, region: REGION, os });
  }

  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  if (warnAndSkipWriteOnEmpty("AWS", cheapest)) return;

  const meta = {
    os: ["Linux","Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    // small constants; replace with real fetcher if you like
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
