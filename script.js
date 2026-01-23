
// Your Cloudflare Worker URL
const WORKER_BASE = "https://cloud-compare.sourishdas0.workers.dev";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    // Load dynamic dropdowns
    const metaResp = await fetch(`${WORKER_BASE}/meta`);
    const { meta } = await metaResp.json();

    fillSelect("region", meta.regions.map(x => ({ value: x.value, text: x.label })));
    fillSelect("os",     meta.os.map(x => ({ value: x.value, text: x.value })));
    fillSelect("cpu",    meta.vcpu.map(v => ({ value: v, text: v })));
    fillSelect("ram",    meta.ram.map(v => ({ value: v, text: v })));

    // default values
    setSelectValue("region", "ap-south-1");
    setSelectValue("os", "Linux");
    setSelectValue("cpu", "2");
    setSelectValue("ram", "4");

  } catch (e) {
    console.error("Failed to load meta:", e);
    alert("Unable to load dynamic options from API.");
  }
}

// Utility to populate <select>
function fillSelect(id, items) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.text;
    sel.appendChild(opt);
  }
}

function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  const opt = Array.from(sel.options).find(o => o.value == value);
  if (opt) sel.value = value;
}

async function compare() {
  const region = document.getElementById("region").value;
  const os     = document.getElementById("os").value;
  const vcpu   = document.getElementById("cpu").value;
  const ram    = document.getElementById("ram").value;

  // Loading state
  document.getElementById("awsInstance").innerText = "Instance: loading...";
  document.getElementById("azInstance").innerText  = "VM Size: loading...";

  try {
    const url = `${WORKER_BASE}/?region=${region}&os=${os}&vcpu=${vcpu}&ram=${ram}`;
    const resp = await fetch(url);
    const { data } = await resp.json();

    // AWS panel
    if (!data.aws.error) {
      document.getElementById("awsInstance").innerText = `Instance: ${data.aws.instance}`;
      document.getElementById("awsCpu").innerText      = `vCPU: ${data.aws.vcpu}`;
      document.getElementById("awsRam").innerText      = `RAM: ${data.aws.ram} GB`;
      document.getElementById("awsPrice").innerText    = `Price/hr: $${data.aws.pricePerHourUSD} (~$${data.aws.monthlyUSD}/mo)`;
    } else {
      document.getElementById("awsInstance").innerText = `Instance: ERROR`;
      document.getElementById("awsPrice").innerText    = data.aws.error;
    }

    // Azure panel
    if (!data.azure.error) {
      document.getElementById("azInstance").innerText = `VM Size: ${data.azure.instance}`;
      document.getElementById("azCpu").innerText      = `vCPU: ${data.azure.vcpu}`;
      document.getElementById("azRam").innerText      = `RAM: ${data.azure.ram} GB`;
      document.getElementById("azPrice").innerText    = `Price/hr: $${data.azure.pricePerHourUSD} (~$${data.azure.monthlyUSD}/mo)`;
    } else {
      document.getElementById("azInstance").innerText = `VM Size: ERROR`;
      document.getElementById("azPrice").innerText    = data.azure.error;
    }

  } catch (e) {
    console.error("Compare failed:", e);
    alert("Could not reach backend API.");
  }
}
