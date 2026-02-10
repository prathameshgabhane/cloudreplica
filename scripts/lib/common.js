// scripts/lib/common.js
const fs = require("fs");
const path = require("path");

function atomicWrite(filePath, dataObj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, path.basename(filePath).replace(/\.json$/, ".tmp.json"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2));
  fs.renameSync(tmp, filePath);
}

function safeJSON(str, fallback = {}) {
  try { return JSON.parse(String(str)); } catch { return fallback; }
}

function uniqSortedNums(arr) {
  return [...new Set(arr.filter(Number.isFinite))].sort((a, b) => a - b);
}

function dedupeCheapestByKey(list, keyFn) {
  const map = new Map();
  for (const row of list) {
    const k = keyFn(row);
    if (!map.has(k) || row.pricePerHourUSD < map.get(k).pricePerHourUSD) {
      map.set(k, row);
    }
  }
  return [...map.values()];
}

function warnAndSkipWriteOnEmpty(provider, list) {
  if (!Array.isArray(list) || list.length === 0) {
    console.warn(`⚠️ FAILOVER: ${provider} list is empty. Skipping write to keep last-known-good file.`);
    return true;
  }
  return false;
}

function logStart(name) {
  console.log(`▶ ${name} ...`);
}

function logDone(name) {
  console.log(`✅ ${name} done`);
}

module.exports = {
  atomicWrite,
  safeJSON,
  uniqSortedNums,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone
};
