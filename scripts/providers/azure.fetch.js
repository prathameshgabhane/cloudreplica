// scripts/providers/azure.fetch.js
// Node 18+ (global fetch)
const fs = require("fs");
const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");
const {
  detectOsFromProductName,
  getResourceSkusMap,
  categorizeByInstanceName,
  widenAzureSeries
} = require("../lib/azure");

const OUT = path.join("data", "azure", "azure.prices.json");
const REGION = process.env.AZURE_REGION || "eastus";

/* ------------------------------------------------------------------
   🔥 Resilient fetch with retry + backoff
   Handles Azure Retail API 429, 500, 503, network drops, bad pages.
--------------------------------------------------------------------*/
async function fetchWithRetry(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);

      if (res.ok) {
        return res.json();
      }

      console.warn(
        `[Azure] Retail HTTP ${res.status} on attempt ${i + 1}/${retries}`
      );
    } catch (err) {
      console.warn(
        `[Azure] Retail error on attempt ${i + 1}/${retries} → ${err.message}`
      );
    }

    // Exponential backoff: 1.5s, 3s, 6s, 12s, 24s...
    await new Promise(res => setTimeout(res, 1500 * Math.pow(2, i)));
  }

  throw new Error(`[Azure] Retail failed after ${retries} retries → ${url}`);
}

/* ------------------------------------------------------------------
   🔥 Retail price fetcher with retry for each page
--------------------------------------------------------------------*/
async function fetchRetailPrices() {
  logStart(`[Azure] Retail (PAYG) ${REGION}`);

  const base =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${REGION}' and type eq 'Consumption'`;

  const items = [];
  let next = base, pages = 0, MAX = 200;

  while (next && pages < MAX) {
    const j = await fetchWithRetry(next);   // <<-- RETRY FIX
    items.push(...(j.Items || []));
    next = j.NextPageLink || null;
    pages++;
  }

  logDone(`[Azure] Retail count=${items.length}`);
  return items;
}

/* ------------------------------------------------------------------
   🔥 MAIN
--------------------------------------------------------------------*/
async function main() {
  // 1) Retail prices with retry
  const retail = await fetchRetailPrices();

  // 2) Normalize + strict filtering to standard PAYG
  const pre = [];
  for (const it of retail) {

    // --- Unit must be hourly
    const uom = (it.unitOfMeasure || "").toLowerCase();
    if (!uom.includes("hour")) continue; // FIXED (Azure sometimes returns "1H", "Hour", etc.)

    // --- Textual exclusions
    const blob = [
      it.productName, it.skuName, it.meterName, it.armSkuName, it.retailPriceType
    ].filter(Boolean).join(" ").toLowerCase();

    if (/\bpromo\b/.test(blob)) continue;
    if (/dev\s*\/?\s*test|devtest/.test(blob)) continue;
    if (/spot|low\s*priority/.test(blob)) continue;
    if (/reservation|reserved/.test(blob)) continue;
    if (/savings\s*plan/.test(blob)) continue;
    if (/\bahb\b|hybrid\s*benefit/.test(blob)) continue;

    // --- Instance extraction
    const skuName = it?.skuName || "";
    const armSku  = it?.armSkuName || "";
    const instance = (skuName.split(" ")[0] || armSku || "").trim();
    if (!instance) continue;
    if (!widenAzureSeries(instance)) continue;

    // --- OS + price
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
  console.log(`[Azure] collected=${pre.length}, cheapest=${cheapest.length}`);
  if (warnAndSkipWriteOnEmpty("Azure", cheapest)) return;

  // 3) Optionally enrich with ResourceSkus
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const armToken = process.env.ARM_TOKEN;

  const skuMap =
    subscriptionId && armToken
      ? await getResourceSkusMap({ subscriptionId, region: REGION, armToken })
      : new Map();

  for (const vm of cheapest) {
    const spec = skuMap.get(String(vm.instance).toLowerCase());
    vm.vcpu = spec?.vcpu ?? null;
    vm.ram  = spec?.ram  ?? null;
    vm.category = categorizeByInstanceName(vm.instance);
  }

  // 4) Meta + storage
  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    ssd_monthly: { 128: 9.6, 256: 19.2 },
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
