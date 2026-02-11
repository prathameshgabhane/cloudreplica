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

 async function fetchRetailPrices() {
   logStart(`[Azure] Retail (PAYG) ${REGION}`);

   const base =
     `https://prices.azure.com/api/retail/prices` +
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

   // 2) Normalize + strict filtering to standard PAYG
   const pre = [];
   for (const it of retail) {
     // --- Strong prefilters for standard on-demand ---
     // (a) correct unit
     const uom = (it.unitOfMeasure || "").toLowerCase();
     if (uom !== "1 hour") continue;

     // (b) textual exclusions: promo/devtest/spot/reservation/savings/AHB
     const blob = [
       it.productName, it.skuName, it.meterName, it.armSkuName, it.retailPriceType
     ].filter(Boolean).join(" ").toLowerCase();

     if (/\bpromo\b/.test(blob)) continue;
     if (/dev\s*\/?\s*test|devtest/.test(blob)) continue;
     if (/spot|low\s*priority/.test(blob)) continue;
     if (/reservation|reserved/.test(blob)) continue;
     if (/savings\s*plan/.test(blob)) continue;
     if (/\bahb\b|hybrid\s*benefit/.test(blob)) continue;

     // (c) instance name + family scope
     const skuName = it?.skuName || "";
     const armSku  = it?.armSkuName || "";
     const instance = (skuName.split(" ")[0] || armSku || "").trim();
     if (!instance) continue;
     if (!widenAzureSeries(instance)) continue;

     // (d) OS extraction (and basic consistency guard)
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

   // 3) Enrich with vCPU/RAM via ResourceSkus (optional when token/subscription provided)
   const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
   const armToken = process.env.ARM_TOKEN;

   const skuMap =
     subscriptionId && armToken
       ? await getResourceSkusMap({ subscriptionId, region: REGION, armToken })
       : new Map();

   for (const vm of cheapest) {
     const spec = skuMap.get(String(vm.instance).toLowerCase());
     vm.vcpu = spec?.vcpu ?? null;
     vm.ram  = spec?.ram  ?? null; // GiB
     vm.category = categorizeByInstanceName(vm.instance);
   }

   // 4) Build meta & storage
   const meta = {
     os: ["Linux", "Windows"],
     vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
     ram:  uniqSortedNums(cheapest.map(x => x.ram))
   };

   // Keep minimal storage defaults here; UI now merges over defaults safely
   const storage = {
     region: REGION,
     ssd_monthly: { 128: 9.6, 256: 19.2 },  // minimal placeholders; UI will merge defaults for other sizes
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
