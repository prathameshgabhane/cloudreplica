// scripts/lib/aws.js
function isWantedEc2Family(instance = "") {
  // m c r t x i z h
  const c = String(instance)[0]?.toLowerCase();
  return ["m","c","r","t","x","i","z","h"].includes(c);
}

module.exports = { isWantedEc2Family };
