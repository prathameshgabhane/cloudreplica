// scripts/lib/azure.js
// Helpers for Azure Retail Prices + ResourceSkus enrichment

function detectOsFromProductName(productName = "") {
  return /windows/i.test(productName) ? "Windows" : "Linux";
}

// Simple family tag by first letter (D=general,E=memory,F=compute, else other)
function categorizeByInstanceName(instance = "") {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = body[0];
  return lead === "d" ? "general" :
         lead === "e" ? "memory"  :
         lead === "f" ? "compute" : "other";
}

async function getResourceSkusMap({ subscriptionId, region, armToken }) {
  const map = new Map();
  let next = `https://management.azure.com/subscriptions/${subscriptionId}` +
             `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${region}'`;

  let pages = 0, MAX = 80;
  while (next && pages < MAX) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${armToken}` }
    });
    if (!res.ok) {
      console.warn(`[Azure] ResourceSkus HTTP ${res.status}`);
      break;
    }
    const j = await res.json();
    for (const sku of (j.value || [])) {
      if (sku.resourceType !== "virtualMachines") continue;
      const caps = Object.fromEntries((sku.capabilities || []).map(x => [x.name, x.value]));
      const v = caps.vCPUs ? Number(caps.vCPUs) : null;
      const m = caps.MemoryGB ? Number(caps.MemoryGB) : null;
      if (v || m) map.set(String(sku.name).toLowerCase(), { vcpu: v, ram: m });
    }
    next = j.nextLink || null;
    pages++;
  }
  console.log(`[Azure] ResourceSkus entries: ${map.size}`);
  return map;
}

function widenAzureSeries(instance) {
  // allow major families we care about: A,B,D,E,F,L,M,N
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = (body[0] || "").toUpperCase();
  return ["A","B","D","E","F","L","M","N"].includes(lead);
}

module.exports = {
  detectOsFromProductName,
  getResourceSkusMap,
  categorizeByInstanceName,
  widenAzureSeries
};
