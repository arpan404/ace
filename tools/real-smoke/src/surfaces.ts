declare global {
  interface Window {
    aceSmokeAlerts?: string[];
  }
}

/** Serialized into the browser; preserve short-lived toasts until the next screenshot. */
export function observeSurfaces() {
  window.aceSmokeAlerts = [];
  const selector =
    '[role="alert"], [role="alertdialog"], [data-slot="toast-root"], [class~="group/toast"]';
  const capture = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    const surfaces = [...element.querySelectorAll(selector)];
    const enclosing = element.closest(selector);
    if (enclosing) surfaces.push(enclosing);
    for (const surface of surfaces) {
      const content = surface.textContent?.trim().slice(0, 2000);
      const text = surface.querySelector(".text-status-failed") ? `error: ${content}` : content;
      const saved = window.aceSmokeAlerts;
      if (text && saved && saved.length < 100 && !saved.includes(text)) saved.push(text);
    }
  };
  new MutationObserver((changes) => {
    for (const change of changes) {
      capture(change.target);
      for (const node of change.addedNodes) capture(node);
      for (const node of change.removedNodes) capture(node);
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["role"],
  });
}
