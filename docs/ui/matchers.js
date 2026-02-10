// docs/ui/matchers.js
// All matching logic: normalization, families, scoring, inference, and fallbacks

export function normalizeOs(val) {
  const s = String(val || '').toLowerCase();
  if (s.startsWith('win')) return 'windows';
  return 'linux';
}

export function isOnDemandShared(x) {
  const bm  = String(x.billingModel || '').toLowerCase();  // expect "ondemand"
  const ten = String(x.tenancyType || '').toLowerCase();   // expect "shared"
  const okBilling = (!bm || bm === 'ondemand');
  const okTenancy = (!ten || ten === 'shared');

  const blob = [x.productName, x.skuName, x.meterName, x.instance]
    .filter(Boolean).join(" ").toLowerCase();

  const looksSpot = blob.includes("low priority") || blob.includes("spot")
                 || blob.includes("savings plan") || blob.includes("reserved");

  return okBilling && okTenancy && !looksSpot;
}

export function isAwsInFamily(inst, family) {
  if (!family) return true;
  const s = String(inst || "").toLowerCase();
  if (family === "general")  return /^[mt]/.test(s);
  if (family === "compute")  return /^c/.test(s);
  if (family === "memory")   return /^[rxz]/.test(s);
  return true;
}

export function isAzureInFamily(inst, family) {
  if (!family) return true;
  const n = String(inst || "").toLowerCase();
  const m = n.match(/standard_([a-z]+)/);
  const first = m?.[1]?.[0] || n[0] || null;
  if (!first) return true;

  if (family === "general")  return first === "d" || first === "b";
  if (family === "compute")  return first === "f";
  if (family === "memory")   return first === "e" || first === "m";
  return true;
}

// Prefer server category (from backend) when present; fallback to first-letter rule
export function azureFamilyMatch(row, family) {
  if (!family) return true;
  const fam = String(family).toLowerCase();
  const cat = String(row?.category || "").toLowerCase();

  if (cat) {
    if (fam === "general") return cat === "general";
    if (fam === "compute") return cat === "compute";
    if (fam === "memory")  return cat === "memory";
    return true;
  }
  return isAzureInFamily(row?.instance, family);
}

export function distance(a, b) {
  if (!isFinite(a) || !isFinite(b)) return 1000;
  return Math.abs(Number(a) - Number(b));
}

// Improved inference (best-effort) for constrained v7 titles like F16-4ams_v7
export function inferAzureCoresRamFromName(name) {
  if (!name || typeof name !== "string") return { vcpu: null, ram: null };
  const n = name.toLowerCase();

  let coreMatch = n.match(/standard_[a-z]+(\d+)[a-z]*/i);
  if (!coreMatch) coreMatch = n.match(/[a-z]+(\d+)-/i);  // e.g., F16-4ams_v7 -> 16
  const vcpu = coreMatch ? Number(coreMatch[1]) : null;

  let familyRamPerCore = null;
  if (n.startsWith("standard_d")) familyRamPerCore = 4;
  else if (n.startsWith("standard_f")) familyRamPerCore = 2;
  else if (n.startsWith("standard_e")) familyRamPerCore = 8;
  else if (n.startsWith("standard_b")) familyRamPerCore = 4;
  else if (n.startsWith("standard_m")) familyRamPerCore = 16;

  const ram = (vcpu && familyRamPerCore) ? vcpu * familyRamPerCore : null;
  return { vcpu, ram };
}

// ---------- Finders ----------
export function findBestAws(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("AWS price list is empty");

  const wantOS = String(os || "").toLowerCase();

  const filtered = list.filter(x =>
    isOnDemandShared(x) &&
    isFinite(x.vcpu) &&
    isFinite(x.ram) &&
    isFinite(x.pricePerHourUSD) &&
    (!wantOS || normalizeOs(x.os) === wantOS) &&
    isAwsInFamily(x.instance, family)
  );
  if (filtered.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No AWS entries for OS=${os || "any"}${fLabel}`);
  }

  let best = null, bestScore = Infinity;
  for (const x of filtered) {
    const score = distance(x.vcpu, vcpu) + distance(x.ram, ram);
    const tieBreaker = x.pricePerHourUSD;
    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x; bestScore = score;
    }
  }
  return best;
}

export function findBestAzure(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("Azure price list is empty");

  const wantOS = String(os || "").toLowerCase();

  // 1) strict: OS + family (accept Unknown OS)
  let pre = list.filter(x =>
    isOnDemandShared(x) &&
    azureFamilyMatch(x, family) &&
    (normalizeOs(x.os) === wantOS || x.os === "Unknown")
  );

  // 2) if empty AND a family was selected, retry WITHOUT family (still honoring OS)
  if (pre.length === 0 && family) {
    pre = list.filter(x =>
      isOnDemandShared(x) &&
      (normalizeOs(x.os) === wantOS || x.os === "Unknown")
    );
  }

  // 3) final fallback: ignore OS completely (rare)
  if (pre.length === 0) {
    pre = list.filter(x => isOnDemandShared(x) && azureFamilyMatch(x, family));
  }

  if (pre.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No Azure entries for OS=${os || "any"}${fLabel}`);
  }

  // Prefer entries with known specs; fallback to inference
  const enriched = pre.map(x => {
    if (isFinite(x.vcpu) && isFinite(x.ram)) return x;
    const meta = inferAzureCoresRamFromName(x.instance);
    return { ...x, vcpu: x.vcpu ?? meta.vcpu, ram: x.ram ?? meta.ram };
  });

  let best = null, bestScore = Infinity;
  for (const x of enriched) {
    const hasSpecs = isFinite(x.vcpu) && isFinite(x.ram);
    let score = hasSpecs
      ? distance(x.vcpu, vcpu) + distance(x.ram, ram)
      : 9999; // penalize unknown specs

    if (x.os === "Unknown") score += 0.5; // prefer exact-OS rows
    const tieBreaker = x.pricePerHourUSD ?? Infinity;

    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x; bestScore = score;
    }
  }
  if (best) best.os = os; // reflect user choice
  return best;
}
