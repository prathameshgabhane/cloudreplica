
// ------------------------------
// UI Options (edit here as needed)
// ------------------------------
const META = {
  regions: [
    { value: "ap-south-1", label: "AWS Mumbai / Azure Central India" },
    { value: "us-east-1",  label: "AWS N. Virginia / Azure East US" }
  ],
  os:   [{ value: "Linux" }, { value: "Windows" }],
  vcpu: [1, 2, 4, 8, 16],
  ram:  [1, 2, 4, 8, 16, 32]
};

// Map the shared "region" selection to each provider's region id
const REGION_MAP = {
  "ap-south-1": { aws: "ap-south-1", azure: "centralindia" },
  "us-east-1":  { aws: "us-east-1",  azure: "eastus" }
};

// Choose a reasonable shape purely by vCPU (you can refine with RAM if you like)
function pickAzureSku(vcpu) {
  if (vcpu <= 2) return "Standard_B2ms";
  if (vcpu <= 4) return "Standard_D4s_v5";
  return "Standard_D8s_v5";
}
function pickAwsInstance(vcpu) {
  if (vcpu <= 2) return "t3.small";
  if (vcpu <= 4) return "t3.medium";
  return "m6a.xlarge";
}

// Helpers
const fmt = n => (n == null || isNaN(n)) ? "-" : `$${n.toFixed(4)}`;
const monthly = priceHr => (priceHr == null || isNaN(priceHr)) ? null : (priceHr * 730);

// Initialize dropdowns
document.addEventListener("DOMContentLoaded", () => {
  fillSelect("region", META.regions.map(x => ({ value: x.value, text: x.label })));
  fillSelect("os",     META.os.map(x => ({ value: x.value, text: x.value })));
  fillSelect("cpu",    META.vcpu.map(v => ({ value: v, text: v })));
  fillSelect("ram",    META.ram.map(v => ({ value: v, text: v })));

  setSelectValue("region", "ap-south-1");
  setSelectValue("os", "Linux");
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");
});

function fillSelect(id, items) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.text;
    el.appendChild(opt);
  }
}
function setSelectValue(id, value) {
  const el = document.getElementById(id);
  const match = Array.from(el.options).find(o => o.value == value);
  if (match) el.value = value;
}

function setStatus(msg, level="info") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = (level === "error") ? "var(--err)" :
                   (level === "warn")  ? "var(--warn)" : "var(--muted)";
}

async function compare() {
  const btn = document.getElementById("compareBtn");
  btn.disabled = true;
  setStatus("Fetching prices…");

  const regionKey = document.getElementById("region").value;
  const os       = document.getElementById("os").value.toLowerCase(); // linux|windows
  const vcpu     = Number(document.getElementById("cpu").value);
  const ram      = Number(document.getElementById("ram").value);
  const mapping  = REGION_MAP[regionKey];

  // Pick shapes
  const azureSku    = pickAzureSku(vcpu);
  const awsInstance = pickAwsInstance(vcpu);

  // Reset UI placeholders
  document.getElementById("awsInstance").innerText = "Instance: loading…";
  document.getElementById("azInstance").innerText  = "VM Size: loading…";
  document.getElementById("awsPrice").innerText    = "Price/hr: -";
  document.getElementById("azPrice").innerText     = "Price/hr: -";
  document.getElementById("awsMonthly").innerText  = "≈ Monthly: -";
  document.getElementById("azMonthly").innerText   = "≈ Monthly: -";

  try {
    // ---------------- Azure Retail Prices (public) ----------------
    // Docs: https://learn.microsoft.com/azure/cost-management-billing/retail-prices/retail-prices
    const osFilter = (os === "windows")
      ? " and contains(productName,'Windows')"
      : " and not contains(productName,'Windows')";

    // We look for "Virtual Machines", region, SKU, and PAYG (Consumption)
    const azUrl =
      `https://prices.azure.com/api/retail/prices?$filter=` +
      `serviceName eq 'Virtual Machines'` +
      ` and armRegionName eq '${mapping.azure}'` +
      ` and skuName eq '${azureSku}'` +
      ` and priceType eq 'Consumption'${osFilter}`;

    const azResp = await fetch(azUrl);
    if (!azResp.ok) throw new Error(`Azure API ${azResp.status}`);
    const azJson = await azResp.json();

    // Items can include several meters; prefer an hourly meter
    const azItem   = (azJson.Items || []).find(x => (x.unitOfMeasure || "").toLowerCase().includes("hour"));
    const azPrice  = azItem ? Number(azItem.retailPrice) : null;
    const azMonth  = monthly(azPrice);

    // ---------------- AWS EC2 Price List (public) ----------------
    // Docs: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-ppslong.html
    // Bulk regional file (large JSON)
    const awsUrl  = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${mapping.aws}/index.json`;
    const awsResp = await fetch(awsUrl);
    if (!awsResp.ok) throw new Error(`AWS Price JSON ${awsResp.status}`);
    const awsJson = await awsResp.json();

    // Find the product by attributes
    const candidates = Object.values(awsJson.products || {}).filter(p => {
      const a = p.attributes || {};
      return a.instanceType === awsInstance &&
             (a.operatingSystem || "").toLowerCase() === os &&
             a.tenancy === "Shared" &&
             a.preInstalledSw === "NA" &&
             a.capacitystatus === "Used";  // On-Demand
    });

    let awsPrice = null;
    if (candidates.length) {
      const sku   = candidates[0].sku;
      const terms = awsJson.terms?.OnDemand?.[sku];
      const term  = terms && Object.values(terms)[0];
      const dim   = term && Object.values(term.priceDimensions || {})[0];
      awsPrice = dim ? Number(dim.pricePerUnit?.USD || 0) : null;
    }
    const awsMonth = monthly(awsPrice);

    // ---------------- Update UI ----------------
    // AWS
    document.getElementById("awsInstance").innerText = `Instance: ${awsInstance}`;
    document.getElementById("awsCpu").innerText      = `vCPU: ${vcpu}`;
    document.getElementById("awsRam").innerText      = `RAM: ${ram} GB`;
    document.getElementById("awsPrice").innerText    = `Price/hr: ${fmt(awsPrice)}`;
    document.getElementById("awsMonthly").innerText  = `≈ Monthly: ${fmt(awsMonth)}`;

    // Azure
    document.getElementById("azInstance").innerText  = `VM Size: ${azureSku}`;
    document.getElementById("azCpu").innerText       = `vCPU: ${vcpu}`;
    document.getElementById("azRam").innerText       = `RAM: ${ram} GB`;
    document.getElementById("azPrice").innerText     = `Price/hr: ${fmt(azPrice)}`;
    document.getElementById("azMonthly").innerText   = `≈ Monthly: ${fmt(azMonth)}`;

    setStatus("Done ✓", "info");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    alert("Unable to get prices. Please try again.");
  } finally {
    btn.disabled = false;
  }
}
