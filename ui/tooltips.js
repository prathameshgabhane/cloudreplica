// ui/tooltips.js
export function initStorageTypeTooltip() {
  const btn = document.getElementById("storageInfoBtn");
  const tip = document.getElementById("storageInfoTip");
  const label = document.querySelector('label[for="storageType"].label-with-info');
  const select = document.getElementById("storageType");
  if (!btn || !tip || !label || !select) return;

  function positionTip() {
    const rect = select.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const left = rect.left + scrollX;
    const top  = rect.bottom + scrollY + 6;
    tip.style.position = "absolute";
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
    const arrow = tip.querySelector(".info-pop__arrow");
    if (arrow) {
      const btnRect = btn.getBoundingClientRect();
      const offset = Math.max(10, Math.min(28, btnRect.left - rect.left));
      arrow.style.left = `${offset}px`;
    }
  }
  function openTip() {
    positionTip();
    tip.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outsideClose, { capture: true });
    document.addEventListener("keydown", escClose);
  }
  function closeTip() {
    tip.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideClose, { capture: true });
    document.removeEventListener("keydown", escClose);
  }
  function toggleTip() {
    const open = tip.getAttribute("aria-hidden") === "false";
    open ? closeTip() : openTip();
  }
  function outsideClose(e) {
    if (tip.contains(e.target) || btn.contains(e.target) || label.contains(e.target) || select.contains(e.target)) return;
    closeTip();
  }
  function escClose(e) { if (e.key === "Escape") closeTip(); }

  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleTip(); });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTip(); }
  });
  window.addEventListener("resize", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
  window.addEventListener("scroll", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
}

export function initOsTypeTooltip() {
  const btn = document.getElementById("osInfoBtn");
  const tip = document.getElementById("osInfoTip");
  let label = document.querySelector('label[for="os"].label-with-info')
           || document.querySelector('label[for="os"]');
  const select = document.getElementById("os");
  if (!btn || !tip || !label || !select) {
    console.warn("[initOsTypeTooltip] Missing elements:", { btn: !!btn, tip: !!tip, label: !!label, select: !!select });
    return;
  }

  function getAnchorRect() { return (label || select).getBoundingClientRect(); }
  function positionTip() {
    const rect   = getAnchorRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const left = rect.left + scrollX;
    const top  = rect.bottom + scrollY + 6;
    tip.style.position = "absolute";
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
    const arrow = tip.querySelector(".info-pop__arrow");
    if (arrow) {
      const btnRect = btn.getBoundingClientRect();
      const offset = Math.max(10, Math.min(28, btnRect.left - rect.left));
      arrow.style.left = `${offset}px`;
    }
  }
  function openTip() {
    positionTip();
    tip.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outsideClose, { capture: true });
    document.addEventListener("keydown", escClose);
  }
  function closeTip() {
    tip.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideClose, { capture: true });
    document.removeEventListener("keydown", escClose);
  }
  function toggleTip() {
    const open = tip.getAttribute("aria-hidden") === "false";
    open ? closeTip() : openTip();
  }
  function outsideClose(e) {
    if (tip.contains(e.target) || btn.contains(e.target) || label.contains(e.target) || select.contains(e.target)) return;
    closeTip();
  }
  function escClose(e) { if (e.key === "Escape") closeTip(); }

  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleTip(); });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTip(); }
  });
  window.addEventListener("resize", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
  window.addEventListener("scroll", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
}
