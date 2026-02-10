// scripts/providers/azure.fetch.js
// Node 18+ (global fetch)
const fs = require("fs");
const path = require("path");
const { atomicWrite, dedupeCheapestByKey, warnAndSkipWriteOnEmpty, logStart, logDone, uniqSortedNums } = require("../lib/common");
const { detectOsFromProductName, getResourceSkusMap, categorizeByInstanceName, widenAzureSeries } = require("../lib/azure");

const OUT = path.join("data", "azure", "prices.json");
const REGION = process.env.AZURE_REGION || "eastus";

async function fetchRetailPrices() {
  logStart(`[Azure] Retail (PAYG) ${REGION}`);

  const base = `https://prices.azure.com/api/retail/prices` +
    `?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${REGION}' and type eq 'Consumption'`;

  const items = [];
  let next = base, pages = 0, MAX = 200;
  while (next && pages < MAX) {
    const r = await fetch(next);
    if (!r.ok) throw new Error(`[Azure] Retail HTTP ${r.status}`);
    const j = await r.json();
    items.push(...(j.Items || []));
    next = j.NextPageLink || null;
    pages++;
  }
  logDone(`[Azure] Retail count=${items.length}`);
  return items;
}

async function main() {
  // 1) Retail prices
  const retail = await fetchRetailPrices();

  // 2) Normalize + cheap-per (instance,region,OS)
  const pre = [];
  for (const it of retail) {
    const skuName = it?.skuName || "";
    const armSku = it?.armSkuName || "";
    const instance = (skuName.split(" ")[0] || armSku || "").trim();
    if (!instance) continue;

    if (!widenAzureSeries(instance)) continue; // filter to main families

    const os = detectOsFromProductName(it.productName);
    const price = Number(it.unitPrice);
    if (!Number.isFinite(price) || price <= 0) continue;

    pre.push({
      instance,
      pricePerHourUSD: price,
      region: REGION,
      os
    });
  }

  const cheapest = dedupeCheapestByKey(pre, r => `${r.instance}-${r.region}-${r.os}`);
  if (warnAndSkipWriteOnEmpty("Azure", cheapest)) return;

  // 3) Enrich with vCPU/RAM via ResourceSkus
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const armToken = process.env.ARM_TOKEN;

  const skuMap = (subscriptionId && armToken)
    ? await getResourceSkusMap({ subscriptionId, region: REGION, armToken })
    : new Map();

  for (const vm of cheapest) {
    const spec = skuMap.get(String(vm.instance).toLowerCase());
    vm.vcpu = spec?.vcpu ?? null;
    vm.ram  = spec?.ram  ?? null; // GiB
    vm.category = categorizeByInstanceName(vm.instance);
  }

  // 4) Build meta & storage (storage pulled from separate script if you like; or keep small defaults)
  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Keep minimal storage defaults here; replace with a fetcher if needed
  const storage = {
    region: REGION,
    ssd_monthly: { 128: 9.6, 256: 19.2 },  // placeholders (ok to adjust)
    hdd_monthly: { 128: 5.888, 256: 11.328 }
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
