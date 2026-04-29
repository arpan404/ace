const MODAL_SURFACE_SELECTOR = [
  "[data-slot='dialog-popup']",
  "[data-slot='sheet-popup']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='alert-dialog-content']",
].join(", ");

const MODAL_PORTAL_PART_SELECTOR = [
  "[data-base-ui-inert]",
  "[data-slot='dialog-backdrop']",
  "[data-slot='dialog-viewport']",
  "[data-slot='dialog-popup']",
  "[data-slot='sheet-backdrop']",
  "[data-slot='sheet-viewport']",
  "[data-slot='sheet-popup']",
  "[data-slot='command-dialog-backdrop']",
  "[data-slot='command-dialog-viewport']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='alert-dialog-overlay']",
  "[data-slot='alert-dialog-content']",
].join(", ");

function isElementVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || element.hidden) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  return true;
}

function hasVisibleModalSurface(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll(MODAL_SURFACE_SELECTOR)).some(isElementVisible);
}

function clearStaleModalPortalParts(doc: Document): void {
  for (const inertBackdrop of doc.querySelectorAll("[data-base-ui-inert]")) {
    const portalRoot = inertBackdrop.parentElement;
    if (!portalRoot || hasVisibleModalSurface(portalRoot)) {
      continue;
    }

    for (const stalePart of Array.from(portalRoot.querySelectorAll(MODAL_PORTAL_PART_SELECTOR))) {
      stalePart.remove();
    }
  }
}

function releaseStaleFocus(doc: Document): void {
  const activeElement = doc.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return;
  }

  if (!activeElement.isConnected) {
    activeElement.blur();
    return;
  }

  const modalSurface = activeElement.closest(MODAL_SURFACE_SELECTOR);
  if (modalSurface && !isElementVisible(modalSurface)) {
    activeElement.blur();
    return;
  }

  if (activeElement.closest("[data-base-ui-inert]")) {
    activeElement.blur();
  }
}

function clearResidualRootModality(doc: Document): void {
  if (hasVisibleModalSurface(doc)) {
    return;
  }

  doc.getElementById("root")?.removeAttribute("aria-hidden");
  doc.getElementById("root")?.removeAttribute("inert");
  doc.body.removeAttribute("aria-hidden");
  doc.body.removeAttribute("inert");
}

function clearResidualDocumentStyles(doc: Document): void {
  doc.body.style.removeProperty("cursor");
  doc.body.style.removeProperty("user-select");
  doc.documentElement.style.removeProperty("cursor");
  doc.documentElement.style.removeProperty("user-select");
}

export function recoverWindowInteractions(doc: Document = document): void {
  clearStaleModalPortalParts(doc);
  clearResidualRootModality(doc);
  releaseStaleFocus(doc);
  clearResidualDocumentStyles(doc);
}

export function installWindowInteractionRecovery(win: Window = window): () => void {
  let pendingResumeRecovery = false;

  const markBackgrounded = () => {
    pendingResumeRecovery = true;
  };

  const scheduleRecovery = () => {
    win.requestAnimationFrame(() => {
      recoverWindowInteractions(win.document);
    });
  };

  const recoverIfNeeded = () => {
    if (!pendingResumeRecovery || win.document.visibilityState === "hidden") {
      return;
    }

    pendingResumeRecovery = false;
    scheduleRecovery();
  };

  const handleVisibilityChange = () => {
    if (win.document.visibilityState === "hidden") {
      markBackgrounded();
      return;
    }

    recoverIfNeeded();
  };

  const unsubscribeNativeResume = win.desktopBridge?.onWindowResume?.(() => {
    if (win.document.visibilityState === "hidden") {
      pendingResumeRecovery = true;
      return;
    }

    pendingResumeRecovery = false;
    scheduleRecovery();
  });

  win.addEventListener("blur", markBackgrounded);
  win.addEventListener("focus", recoverIfNeeded);
  win.document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    unsubscribeNativeResume?.();
    win.removeEventListener("blur", markBackgrounded);
    win.removeEventListener("focus", recoverIfNeeded);
    win.document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

export const __interactionRecoveryForTests = {
  MODAL_PORTAL_PART_SELECTOR,
  MODAL_SURFACE_SELECTOR,
  clearResidualRootModality,
  clearStaleModalPortalParts,
  hasVisibleModalSurface,
  releaseStaleFocus,
};
