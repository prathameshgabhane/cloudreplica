
async function compare() {
    const region = document.getElementById("region").value;
    const os     = document.getElementById("os").value.toLowerCase();
    const vcpu   = Number(document.getElementById("cpu").value);
    const ram    = Number(document.getElementById("ram").value);

    // Choose SKUs by vCPU (simple mapping; refine anytime)
    const azureSku = (vcpu <= 2) ? "Standard_B2ms" :
                     (vcpu <= 4) ? "Standard_D4s_v5" :
                                   "Standard_D8s_v5";

    const awsInstance = (vcpu <= 2) ? "t3.small" :
                        (vcpu <= 4) ? "t3.medium" :
                                      "m6a.xlarge";

    // -------------------------
    // FETCH AZURE PRICE
    // -------------------------
    const azureUrl =
        `https://prices.azure.com/api/retail/prices?$filter=` +
        `serviceName eq 'Virtual Machines'` +
        ` and armRegionName eq '${region === "ap-south-1" ? "centralindia" : "eastus"}'` +
        ` and skuName eq '${azureSku}'` +
        ` and priceType eq 'Consumption'` +
        (os === "windows"
            ? ` and contains(productName,'Windows')`
            : ` and not contains(productName,'Windows')`
        );

    const azureResp = await fetch(azureUrl);
    const azureJson = await azureResp.json();
    const azureItem = azureJson.Items.find(x => x.unitOfMeasure.toLowerCase().includes("hour"));
    const azurePrice = azureItem?.retailPrice || null;

    // -------------------------
    // FETCH AWS PRICE
    // -------------------------
    const awsUrl =
        `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;

    const awsResp = await fetch(awsUrl);
    const awsJson = await awsResp.json();

    const awsProducts = Object.values(awsJson.products).filter(p => {
        const a = p.attributes;
        return a.instanceType === awsInstance &&
               a.operatingSystem.toLowerCase() === os &&
               a.capacitystatus === "Used" &&
               a.tenancy === "Shared";
    });

    let awsPrice = null;
    if (awsProducts.length > 0) {
        const sku = awsProducts[0].sku;
        const terms = awsJson.terms.OnDemand[sku];
        const term  = Object.values(terms)[0];
        const dim   = Object.values(term.priceDimensions)[0];
        awsPrice = Number(dim.pricePerUnit.USD);
    }

    // -------------------------
    // UPDATE UI
    // -------------------------

    // AWS
    document.getElementById("awsInstance").innerText = `Instance: ${awsInstance}`;
    document.getElementById("awsCpu").innerText = `vCPU: ${vcpu}`;
    document.getElementById("awsRam").innerText = `RAM: ${ram} GB`;
    document.getElementById("awsPrice").innerText =
        awsPrice ? `Price/hr: $${awsPrice}` : "Price/hr: Not found";

    // Azure
    document.getElementById("azInstance").innerText = `VM Size: ${azureSku}`;
    document.getElementById("azCpu").innerText = `vCPU: ${vcpu}`;
    document.getElementById("azRam").innerText = `RAM: ${ram} GB`;
    document.getElementById("azPrice").innerText =
        azurePrice ? `Price/hr: $${azurePrice}` : "Price/hr: Not found";
}
