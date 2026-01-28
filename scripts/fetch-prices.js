import fetch from "node-fetch";
import fs from "fs";

// Fetch AWS EC2 pricing (Bulk Offer File)
async function fetchAws(region = "us-east-1") {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;
  const data = await (await fetch(url)).json();

  const result = [];

  for (const sku in data.products) {
    const prod = data.products[sku];
    if (prod.productFamily !== "Compute Instance") continue;

    const attributes = prod.attributes;
    const instance = attributes.instanceType;
    const vcpu = Number(attributes.vcpu || 0);
    const ram = Number((attributes.memory || "0 GB").split(" ")[0]);

    const onDemand = data.terms.OnDemand[sku];
    if (!onDemand) continue;

    let price = null;
    for (const term of Object.values(onDemand)) {
      for (const dim of Object.values(term.priceDimensions)) {
        price = Number(dim.pricePerUnit.USD);
      }
    }

    result.push({
      instance,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region,
    });
  }

  return result;
}

// Fetch Azure Retail Prices API
async function fetchAzure(region = "eastus") {
  const url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${region}'&$top=200`;
  const resp = await fetch(url);
  const data = await resp.json();

  return (data.Items || []).map((item) => ({
    instance: item.armSkuName || item.skuName,
    pricePerHourUSD: item.unitPrice,
    region,
    // Azure retail API doesn't consistently expose cores/memory here
    vcpu: null,
    ram: null,
  }));
}

(async () => {
  const aws = await fetchAws();
  const azure = await fetchAzure();

  const output = {
    meta: {
      os: ["Linux", "Windows"],
      vcpu: [1, 2, 4, 8, 16],
      ram: [1, 2, 4, 8, 16, 32],
    },
    aws,
    azure,
  };

  fs.writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
})();
