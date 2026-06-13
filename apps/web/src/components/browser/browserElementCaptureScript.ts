export function buildBrowserElementCaptureScript(
  point: { x: number; y: number },
  overlayViewport?: { width: number; height: number },
): string {
  const serializedPayload = JSON.stringify({
    overlayViewport: overlayViewport
      ? {
          width: Math.max(1, Math.round(overlayViewport.width)),
          height: Math.max(1, Math.round(overlayViewport.height)),
        }
      : null,
    point: {
      x: Math.max(0, Math.floor(point.x)),
      y: Math.max(0, Math.floor(point.y)),
    },
  });
  return `(() => {
  const payload = ${serializedPayload};
  const rawPoint = payload.point;
  const overlayViewport = payload.overlayViewport;
  const toSnippet = (value, maxLength) => {
    if (typeof value !== "string") return null;
    const collapsed = value.replace(/\\s+/g, " ").trim();
    if (!collapsed) return null;
    return collapsed.length > maxLength ? collapsed.slice(0, maxLength - 1) + "…" : collapsed;
  };
  const parseAlpha = (value) => {
    if (typeof value !== "string") return 0;
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "transparent") return 0;
    const rgbaMatch = normalized.match(/^rgba\\((.+)\\)$/);
    if (!rgbaMatch) return 1;
    const parts = rgbaMatch[1].split(",").map((part) => part.trim());
    if (parts.length < 4) return 1;
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) ? alpha : 1;
  };
  const isElementNode = (value) => Boolean(value) && value.nodeType === 1 && typeof value.tagName === "string";
  const clampNumber = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const escapeCss = (value) => {
    if (typeof value !== "string") return "";
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  };
  const resolveViewportMetrics = () => {
    const visualViewport = typeof window.visualViewport === "object" ? window.visualViewport : null;
    const guestWidth = Math.max(
      1,
      Math.round(
        window.innerWidth || visualViewport?.width || document.documentElement?.clientWidth || 1,
      ),
    );
    const guestHeight = Math.max(
      1,
      Math.round(
        window.innerHeight || visualViewport?.height || document.documentElement?.clientHeight || 1,
      ),
    );
    const hostWidth = Math.max(1, Math.round(overlayViewport?.width || guestWidth));
    const hostHeight = Math.max(1, Math.round(overlayViewport?.height || guestHeight));
    const offsetLeft = Number.isFinite(visualViewport?.offsetLeft) ? visualViewport.offsetLeft : 0;
    const offsetTop = Number.isFinite(visualViewport?.offsetTop) ? visualViewport.offsetTop : 0;
    return {
      guestHeight,
      guestWidth,
      hostHeight,
      hostWidth,
      offsetLeft,
      offsetTop,
      scaleX: guestWidth / hostWidth,
      scaleY: guestHeight / hostHeight,
    };
  };
  const viewport = resolveViewportMetrics();
  const point = {
    x: Math.round(
      clampNumber(
        viewport.offsetLeft + rawPoint.x * viewport.scaleX,
        viewport.offsetLeft,
        viewport.offsetLeft + viewport.guestWidth - 1,
      ),
    ),
    y: Math.round(
      clampNumber(
        viewport.offsetTop + rawPoint.y * viewport.scaleY,
        viewport.offsetTop,
        viewport.offsetTop + viewport.guestHeight - 1,
      ),
    ),
  };
  const mapGuestRectToHost = (rect) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const left = Math.max(0, (rect.left - viewport.offsetLeft) / viewport.scaleX);
    const top = Math.max(0, (rect.top - viewport.offsetTop) / viewport.scaleY);
    const right = Math.max(left + 1, (rect.right - viewport.offsetLeft) / viewport.scaleX);
    const bottom = Math.max(top + 1, (rect.bottom - viewport.offsetTop) / viewport.scaleY);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  };
  const selectorFromElement = (element) => {
    if (!isElementNode(element)) return null;
    if (element.id) return "#" + escapeCss(element.id);
    const segments = [];
    let current = element;
    for (let depth = 0; depth < 4 && current && isElementNode(current); depth += 1) {
      let segment = current.tagName.toLowerCase();
      const classList = Array.from(current.classList).slice(0, 2);
      if (classList.length > 0) {
        segment += "." + classList.map(escapeCss).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName,
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current);
          if (index >= 0) {
            segment += ":nth-of-type(" + String(index + 1) + ")";
          }
        }
      }
      segments.unshift(segment);
      if (!parent || current.tagName.toLowerCase() === "body") break;
      current = parent;
    }
    return segments.join(" > ");
  };
  const describe = (element) => {
    if (!isElementNode(element)) return null;
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      className: element.className ? String(element.className) : null,
      selector: selectorFromElement(element),
      textSnippet: toSnippet(element.textContent ?? "", 320),
      htmlSnippet: toSnippet(element.outerHTML ?? "", 1200),
    };
  };
  const toRect = (element) => {
    if (!isElementNode(element)) return null;
    return mapGuestRectToHost(element.getBoundingClientRect());
  };
  const toRoundedRect = (rect) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return mapGuestRectToHost(rect);
  };
  const pointWithinRect = (rect) =>
    rect &&
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom;
  const strongPreferredRoles = new Set([
    "article",
    "button",
    "cell",
    "checkbox",
    "gridcell",
    "link",
    "listitem",
    "menuitem",
    "option",
    "radio",
    "row",
    "switch",
    "tab",
  ]);
  const strongPreferredTags = new Set([
    "a",
    "article",
    "button",
    "figure",
    "img",
    "input",
    "label",
    "li",
    "summary",
  ]);
  const weakPreferredTags = new Set(["aside", "header", "nav", "section"]);
  const ignoredLeafTags = new Set(["b", "em", "i", "path", "small", "span", "strong", "svg"]);
  const mediaTags = new Set(["canvas", "figure", "img", "svg", "video"]);
  const textLikeTags = new Set([
    "blockquote",
    "button",
    "figcaption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "label",
    "legend",
    "li",
    "p",
    "span",
    "summary",
    "yt-formatted-string",
  ]);
  const blockDisplays = new Set([
    "block",
    "flex",
    "grid",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "list-item",
  ]);
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const pageHeight = Math.max(
    window.innerHeight,
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0,
  );
  const measureTextRect = (element) => {
    if (!isElementNode(element)) return null;
    const textContent = (element.textContent || "").replace(/\\s+/g, " ").trim();
    if (!textContent) return null;
    const range = document.createRange();
    try {
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      if (!pointWithinRect(rect) || rect.width < 6 || rect.height < 6) {
        range.detach?.();
        return null;
      }
      range.detach?.();
      return rect;
    } catch (error) {
      range.detach?.();
      throw error;
    }
  };
  const getMetrics = (element) => {
    if (!isElementNode(element)) return null;
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect) || rect.width < 8 || rect.height < 8) {
      return null;
    }
    const style = window.getComputedStyle(element);
    const tagName = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    const area = rect.width * rect.height;
    const isInline =
      style.display.startsWith("inline") &&
      style.display !== "inline-block" &&
      style.display !== "inline-flex" &&
      style.display !== "inline-grid";
    const hasVisualBox =
      parseAlpha(style.backgroundColor) > 0.04 ||
      style.backgroundImage !== "none" ||
      parseFloat(style.borderTopWidth || "0") > 0 ||
      parseFloat(style.borderRightWidth || "0") > 0 ||
      parseFloat(style.borderBottomWidth || "0") > 0 ||
      parseFloat(style.borderLeftWidth || "0") > 0 ||
      style.boxShadow !== "none" ||
      parseFloat(style.borderRadius || "0") > 0;
    const isInteractive =
      strongPreferredTags.has(tagName) ||
      strongPreferredRoles.has(role) ||
      element.hasAttribute("tabindex") ||
      element.hasAttribute("aria-current") ||
      element.hasAttribute("aria-pressed");
    const textLength = (element.textContent || "").replace(/\\s+/g, " ").trim().length;
    const textRect = measureTextRect(element);
    const childCount = element.childElementCount;
    const isCustomElement = tagName.includes("-");
    const isHuge =
      area > viewportArea * 0.72 ||
      (rect.width > window.innerWidth * 0.97 && rect.height > window.innerHeight * 0.52) ||
      rect.height > window.innerHeight * 0.88;
    const isPageSized =
      rect.width >= window.innerWidth * 0.96 &&
      (rect.height >= window.innerHeight * 0.86 || rect.height >= pageHeight * 0.72);
    const isDecorativeBackground =
      !isInteractive &&
      hasVisualBox &&
      isPageSized &&
      textLength < 24 &&
      childCount <= 2;
    return {
      area,
      areaRatio: area / viewportArea,
      childCount,
      display: style.display,
      hasVisualBox,
      isDecorativeBackground,
      isCustomElement,
      isHuge,
      isPageSized,
      isInline,
      isInteractive,
      rect,
      role,
      tagName,
      textRect,
      textLength,
    };
  };
  const isTextSelectable = (metrics) => {
    if (!metrics || metrics.isHuge || metrics.textLength < 14) {
      return false;
    }
    const selectionRect = metrics.textRect ?? metrics.rect;
    const textArea = selectionRect.width * selectionRect.height;
    if (textArea < 120 || selectionRect.height > window.innerHeight * 0.28) {
      return false;
    }
    if (
      selectionRect.width > window.innerWidth * 0.96 &&
      selectionRect.height > window.innerHeight * 0.18
    ) {
      return false;
    }
    return (
      textLikeTags.has(metrics.tagName) ||
      (!metrics.hasVisualBox && (metrics.childCount <= 3 || blockDisplays.has(metrics.display))) ||
      (!metrics.hasVisualBox &&
        metrics.isCustomElement &&
        metrics.textLength >= 18 &&
        selectionRect.height <= 120)
    );
  };
  const isSurfaceSelectable = (metrics, childMetrics) => {
    if (!metrics || metrics.isHuge || metrics.isDecorativeBackground) {
      return false;
    }
    const hasOwnSurface =
      metrics.hasVisualBox ||
      mediaTags.has(metrics.tagName) ||
      strongPreferredTags.has(metrics.tagName);
    if (!hasOwnSurface || metrics.area < 900 || metrics.rect.width < 32 || metrics.rect.height < 24) {
      return false;
    }
    if (
      !metrics.isInteractive &&
      metrics.rect.width > window.innerWidth * 0.86 &&
      metrics.rect.height > window.innerHeight * 0.2
    ) {
      return false;
    }
    if (childMetrics?.hasVisualBox && !metrics.isInteractive) {
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      const centeredAlongX =
        Math.abs(
          (metrics.rect.left + metrics.rect.right) / 2 -
            (childMetrics.rect.left + childMetrics.rect.right) / 2,
        ) <= Math.min(48, metrics.rect.width * 0.08);
      if (centeredAlongX && widthGrowth > 1.1 && heightGrowth < 1.4) {
        return false;
      }
    }
    if (isTextSelectable(childMetrics) && !metrics.isInteractive) {
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      if (metrics.hasVisualBox && (widthGrowth > 1.14 || heightGrowth > 1.14)) {
        return false;
      }
    }
    return true;
  };
  const isMeaningfulChild = (metrics) => {
    if (!metrics) return false;
    if (metrics.isDecorativeBackground) return false;
    return (
      metrics.hasVisualBox ||
      metrics.isInteractive ||
      isTextSelectable(metrics) ||
      strongPreferredTags.has(metrics.tagName) ||
      strongPreferredRoles.has(metrics.role) ||
      metrics.area > 2600 ||
      metrics.rect.width >= 120 ||
      metrics.rect.height >= 56 ||
      metrics.textLength >= 40
    );
  };
  const isWeakLeafCandidate = (metrics) => {
    if (!metrics) return false;
    if (metrics.isDecorativeBackground) return true;
    if (
      metrics.isInteractive ||
      metrics.hasVisualBox ||
      strongPreferredTags.has(metrics.tagName) ||
      strongPreferredRoles.has(metrics.role)
    ) {
      return false;
    }
    return (
      ignoredLeafTags.has(metrics.tagName) ||
      (metrics.isInline && metrics.area < 24000) ||
      (metrics.childCount === 0 &&
        metrics.rect.height < 48 &&
        metrics.rect.width < window.innerWidth * 0.55)
    );
  };
  const resolveSelectableCandidate = (element, depth, pathChild) => {
    const metrics = getMetrics(element);
    if (!metrics) return null;
    if (metrics.isDecorativeBackground) return null;
    const childMetrics = getMetrics(pathChild);
    const isTextCandidate = isTextSelectable(metrics);
    const isSurfaceCandidate = isSurfaceSelectable(metrics, childMetrics);
    const isControlCandidate = metrics.isInteractive;
    if (!isControlCandidate && !isTextCandidate && !isSurfaceCandidate) {
      return null;
    }
    const selectionRect =
      isTextCandidate && !metrics.hasVisualBox ? (metrics.textRect ?? metrics.rect) : metrics.rect;
    if (!selectionRect) {
      return null;
    }
    let score = 0;
    if (isControlCandidate) score += 12;
    if (isTextCandidate) score += 10;
    if (isSurfaceCandidate) score += 8;
    if (strongPreferredTags.has(metrics.tagName)) score += 5;
    if (strongPreferredRoles.has(metrics.role)) score += 4;
    if (!isTextCandidate && weakPreferredTags.has(metrics.tagName)) score += 1.5;
    if (metrics.isCustomElement) score += 4;
    if (metrics.hasVisualBox) score += 5;
    if (blockDisplays.has(metrics.display)) score += 3;
    if (metrics.childCount > 0) score += Math.min(2, metrics.childCount * 0.35);
    if (metrics.textLength > 0) score += Math.min(3, Math.ceil(metrics.textLength / 42));
    if (isTextCandidate && metrics.textRect) {
      score += Math.min(6, metrics.textLength / 18);
    }
    if (metrics.isInline) score -= 7;
    if (!isTextCandidate && ignoredLeafTags.has(metrics.tagName)) score -= 4;
    if (metrics.area < 420) score -= 5;
    if (metrics.isHuge) score -= 12;
    if (!metrics.isInteractive && metrics.rect.width > window.innerWidth * 0.8) score -= 3.5;
    if (
      !metrics.isInteractive &&
      metrics.rect.height < window.innerHeight * 0.34 &&
      metrics.rect.width / Math.max(1, metrics.rect.height) > 5.6
    ) {
      score -= 3;
    }
    if (isMeaningfulChild(childMetrics)) {
      const areaGrowth = metrics.area / Math.max(1, childMetrics.area);
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      const centeredAlongX =
        Math.abs(
          (metrics.rect.left + metrics.rect.right) / 2 -
            (childMetrics.rect.left + childMetrics.rect.right) / 2,
        ) <= Math.min(48, metrics.rect.width * 0.1);
      const similarHeight = heightGrowth <= 1.45;
      if (areaGrowth > 1.45) {
        score -= Math.min(10, (areaGrowth - 1.45) * 4.5);
      }
      if (widthGrowth > 1.16 && similarHeight) {
        score -= Math.min(8, (widthGrowth - 1.16) * 18);
      }
      if (centeredAlongX && widthGrowth > 1.12 && similarHeight) {
        score -= 4;
      }
      if (childMetrics.hasVisualBox && metrics.hasVisualBox && widthGrowth > 1.08) {
        score -= 3;
      }
      if (isTextSelectable(childMetrics) && !isTextCandidate && !metrics.isInteractive) {
        score -= 8;
      }
    }
    score -= depth * 0.45;
    score -= metrics.areaRatio * 8;
    const roundedRect = toRoundedRect(selectionRect);
    if (!roundedRect) {
      return null;
    }
    return {
      depth,
      element,
      rect: roundedRect,
      score,
    };
  };
  const resolveTargetElement = (initialTarget) => {
    if (!isElementNode(initialTarget)) return null;
    const candidates = [];
    const bestCandidateByElement = new Map();
    const resolvePreferredTextCandidate = (elements) => {
      for (const hit of elements.slice(0, 4)) {
        let current = hit;
        for (let depth = 0; current && depth < 4; depth += 1) {
          const metrics = getMetrics(current);
          if (!metrics) {
            break;
          }
          if (isTextSelectable(metrics) && !metrics.hasVisualBox) {
            const rect = toRoundedRect(metrics.textRect ?? metrics.rect);
            if (rect) {
              return {
                depth,
                element: current,
                rect,
                score: Number.POSITIVE_INFINITY,
              };
            }
          }
          if (metrics.hasVisualBox || metrics.isInteractive) {
            break;
          }
          current = current.parentElement;
        }
      }
      return null;
    };
    const considerChain = (start) => {
      let current = start;
      let pathChild = null;
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (isElementNode(current)) {
          const candidate = resolveSelectableCandidate(current, depth, pathChild);
          if (candidate) {
            const existing = bestCandidateByElement.get(current);
            if (!existing || candidate.score > existing.score) {
              bestCandidateByElement.set(current, candidate);
            }
          }
        }
        pathChild = current;
        current = current.parentElement;
      }
    };
    const hitElements =
      typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(point.x, point.y)
        : [initialTarget];
    const filteredHitElements = hitElements.filter((element) => {
      return !isWeakLeafCandidate(getMetrics(element));
    });
    const preferredTextCandidate = resolvePreferredTextCandidate(
      filteredHitElements.length > 0 ? filteredHitElements : hitElements,
    );
    if (preferredTextCandidate) {
      return preferredTextCandidate;
    }
    for (const hit of (filteredHitElements.length > 0 ? filteredHitElements : hitElements).slice(0, 6)) {
      considerChain(hit);
    }
    candidates.push(...bestCandidateByElement.values());
    if (candidates.length === 0) {
      const initialMetrics = getMetrics(initialTarget);
      if (
        !initialMetrics ||
        initialMetrics.isDecorativeBackground ||
        (initialMetrics.isHuge && !initialMetrics.isInteractive)
      ) {
        return null;
      }
      return { element: initialTarget, rect: toRect(initialTarget), score: 0, depth: 0 };
    }
    candidates.sort((left, right) => right.score - left.score || left.depth - right.depth);
    return candidates[0] ?? { element: initialTarget, rect: toRect(initialTarget), score: 0, depth: 0 };
  };
  const x = Math.max(0, Math.floor(point.x));
  const y = Math.max(0, Math.floor(point.y));
  const rawTarget = document.elementFromPoint(x, y);
  const resolvedTarget = resolveTargetElement(rawTarget);
  const target = resolvedTarget?.element ?? null;
  const mainContainer =
     isElementNode(target)
       ? target.closest("main, [role='main'], article, section, [data-testid], [class*='container'], [class*='content']") ?? target.parentElement
       : null;
  return {
    targetRect: resolvedTarget?.rect ?? toRect(target),
    target: describe(target),
    mainContainer: describe(mainContainer),
  };
})();`;
}
