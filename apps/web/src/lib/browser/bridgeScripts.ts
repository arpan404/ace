function serializeBridgePayload(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildBrowserBridgeRuntimeScript(): string {
  return `
  const ACE_BRIDGE_STATE_KEY = "__aceBrowserBridge";
  const MAX_TEXT = 240;
  const MAX_VISIBLE_NODES = 180;
  const MAX_SNAPSHOT_LINES = 220;
  const state = (() => {
    const existing = window[ACE_BRIDGE_STATE_KEY];
    if (existing && existing.nodeById && existing.elementToNodeId) return existing;
    const next = { nextNodeId: 1, nodeById: new Map(), elementToNodeId: new WeakMap() };
    Object.defineProperty(window, ACE_BRIDGE_STATE_KEY, {
      configurable: true,
      enumerable: false,
      value: next,
    });
    return next;
  })();
  const escapeCss = (value) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  };
  const escapeAttr = (value) => String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"");
  const isElement = (value) => value && value.nodeType === Node.ELEMENT_NODE;
  const isVisible = (element) => {
    if (!isElement(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
  };
  const isInViewport = (element) => {
    if (!isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  };
  const textFor = (element) =>
    (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    if (/^h[1-6]$/u.test(tag)) return "heading";
    return null;
  };
  const accessibleNameFor = (element) => {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\\s+/u)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      if (label) return label;
    }
    if (element.id) {
      const label = document.querySelector('label[for="' + escapeAttr(element.id) + '"]');
      if (label?.textContent) return label.textContent.replace(/\\s+/g, " ").trim();
    }
    const title = element.getAttribute("title");
    if (title) return title.trim();
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    return textFor(element);
  };
  const nodeIdFor = (element) => {
    let nodeId = state.elementToNodeId.get(element);
    if (!nodeId) {
      nodeId = "node-" + state.nextNodeId++;
      state.elementToNodeId.set(element, nodeId);
    }
    state.nodeById.set(nodeId, element);
    return nodeId;
  };
  const nodeById = (nodeId) => {
    const element = state.nodeById.get(String(nodeId));
    if (!element || !element.isConnected) {
      throw new Error("No current DOM node matched node_id: " + nodeId);
    }
    return element;
  };
  const selectorFor = (element) => {
    if (element.id) return "#" + escapeCss(element.id);
    const testId = element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + escapeAttr(testId) + '"]';
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        part += "." + Array.from(current.classList).slice(0, 2).map(escapeCss).join(".");
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  };
  const rectFor = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    };
  };
  const describeElement = (element) => ({
    ariaName: accessibleNameFor(element),
    boundingBox: rectFor(element),
    href: element instanceof HTMLAnchorElement ? element.href : null,
    node_id: nodeIdFor(element),
    preview: textFor(element),
    role: roleFor(element),
    selector: {
      candidates: [selectorFor(element)],
      primary: selectorFor(element),
    },
    tagName: element.tagName.toLowerCase(),
    testId: element.getAttribute("data-testid"),
    value: "value" in element ? String(element.value || "") : null,
    visibleText: textFor(element),
  });
  const collectVisibleDom = () => {
    const elements = Array.from(
      document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex],summary,label,[data-testid]")
    )
      .filter(isVisible)
      .slice(0, MAX_VISIBLE_NODES)
      .map(describeElement);
    return {
      elements: elements.map((element, index) => ({
        index,
        href: element.href,
        label: element.ariaName || element.visibleText,
        nodeId: element.node_id,
        rect: element.boundingBox,
        role: element.role,
        selector: element.selector.primary,
        tag: element.tagName,
        value: element.value,
      })),
      nodes: elements,
      title: document.title,
      url: location.href,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  };
  const snapshotSelector = [
    "a",
    "article",
    "aside",
    "button",
    "details",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "input",
    "label",
    "li",
    "main",
    "nav",
    "p",
    "section",
    "select",
    "summary",
    "textarea",
    "[role]",
    "[tabindex]",
    "[data-testid]",
  ].join(",");
  const collectDomSnapshotText = () => {
    const lines = [
      "- page " + JSON.stringify(document.title || "Untitled") + " " + location.href,
      "- viewport " + window.innerWidth + "x" + window.innerHeight + " scroll " + Math.round(window.scrollX) + "," + Math.round(window.scrollY),
    ];
    const seenText = new Set();
    const elements = Array.from(document.querySelectorAll(snapshotSelector))
      .filter(isInViewport)
      .slice(0, MAX_VISIBLE_NODES);
    for (const element of elements) {
      const text = textFor(element);
      const role = roleFor(element);
      const tag = element.tagName.toLowerCase();
      if (!text && !role && tag !== "input" && tag !== "select" && tag !== "textarea") continue;
      const key = tag + "|" + (role || "") + "|" + text;
      if (text && seenText.has(key)) continue;
      if (text) seenText.add(key);
      const nodeId = nodeIdFor(element);
      const label = accessibleNameFor(element);
      const rect = rectFor(element);
      const parts = [
        "-",
        "[" + nodeId + "]",
        role ? tag + "[" + role + "]" : tag,
        rect.x + "," + rect.y + " " + rect.width + "x" + rect.height,
      ];
      const renderedText = label || text;
      if (renderedText) parts.push(JSON.stringify(renderedText));
      if (element instanceof HTMLAnchorElement && element.href) parts.push("href=" + JSON.stringify(element.href));
      if ("value" in element && element.value) parts.push("value=" + JSON.stringify(String(element.value)));
      lines.push(parts.join(" "));
      if (lines.length >= MAX_SNAPSHOT_LINES) break;
    }
    return lines.join("\\n");
  };
  const allElements = () => Array.from(document.querySelectorAll("body *")).filter(isElement);
  const textMatches = (actual, expected, exact) => {
    if (typeof expected !== "string" || expected.length === 0) return true;
    return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
  };
  const uniqueElements = (elements) => Array.from(new Set(elements)).filter(isElement);
  const semanticSelectorForRole = (role) => {
    switch (String(role || "").toLowerCase()) {
      case "button":
        return "button,input[type='button'],input[type='submit'],input[type='reset'],[role='button']";
      case "link":
        return "a[href],[role='link']";
      case "textbox":
        return "input:not([type]),input[type='text'],input[type='search'],input[type='email'],input[type='url'],input[type='tel'],textarea,[role='textbox']";
      case "checkbox":
        return "input[type='checkbox'],[role='checkbox']";
      case "radio":
        return "input[type='radio'],[role='radio']";
      case "combobox":
        return "select,[role='combobox']";
      case "heading":
        return "h1,h2,h3,h4,h5,h6,[role='heading']";
      default:
        return '[role="' + escapeAttr(role) + '"]';
    }
  };
  const resolveLocatorElements = (payload) => {
    const exact = payload.exact === true;
    let candidates = [];
    const selector = payload.selector || payload.locator;
    if (typeof selector === "string" && selector.trim()) {
      const css = selector.startsWith("css=") ? selector.slice(4) : selector;
      candidates.push(...document.querySelectorAll(css));
    }
    const testId = payload.testId || payload.test_id;
    if (typeof testId === "string" && testId.trim()) {
      candidates.push(...document.querySelectorAll('[data-testid="' + escapeAttr(testId) + '"]'));
    }
    if (typeof payload.placeholder === "string" && payload.placeholder.trim()) {
      candidates.push(
        ...Array.from(document.querySelectorAll("input,textarea")).filter((element) =>
          textMatches(element.getAttribute("placeholder") || "", payload.placeholder, exact)
        )
      );
    }
    if (typeof payload.label === "string" && payload.label.trim()) {
      const labels = Array.from(document.querySelectorAll("label")).filter((label) =>
        textMatches(textFor(label), payload.label, exact)
      );
      for (const label of labels) {
        const control = label.control || (label.getAttribute("for") ? document.getElementById(label.getAttribute("for")) : null);
        if (control) candidates.push(control);
      }
      candidates.push(
        ...allElements().filter((element) => textMatches(accessibleNameFor(element), payload.label, exact))
      );
    }
    if (typeof payload.role === "string" && payload.role.trim()) {
      candidates.push(...document.querySelectorAll(semanticSelectorForRole(payload.role)));
    }
    if (typeof payload.text === "string" && payload.text.trim()) {
      candidates.push(
        ...allElements().filter((element) => textMatches(textFor(element), payload.text, exact))
      );
    }
    if (typeof payload.name === "string" && payload.name.trim()) {
      candidates = candidates.filter((element) =>
        textMatches(accessibleNameFor(element), payload.name, exact)
      );
    }
    if (typeof payload.hasText === "string" || typeof payload.has_text === "string") {
      const hasText = payload.hasText || payload.has_text;
      candidates = candidates.filter((element) => textMatches(textFor(element), hasText, false));
    }
    if (candidates.length === 0 && typeof payload.node_id === "string") {
      candidates.push(nodeById(payload.node_id));
    }
    const visible = payload.visible === false ? uniqueElements(candidates) : uniqueElements(candidates).filter(isVisible);
    if (Number.isInteger(payload.index)) {
      const element = visible[payload.index];
      return element ? [element] : [];
    }
    return visible;
  };
  const resolveOneLocatorElement = (payload) => {
    const elements = resolveLocatorElements(payload);
    if (elements.length !== 1) {
      throw new Error("Locator matched " + elements.length + " elements; expected exactly 1.");
    }
    return elements[0];
  };
  const setElementValue = (element, value) => {
    if (!("value" in element)) throw new Error("Matched element cannot be filled.");
    element.focus?.();
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const clickElement = (element, clickCount = 1) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus?.();
    if (clickCount > 1) {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: clickCount }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, detail: clickCount }));
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: clickCount }));
      return;
    }
    element.click();
  };
  const typeIntoActiveElement = (text) => {
    const element = document.activeElement;
    if (!element || element === document.body) throw new Error("No focused element is available for typing.");
    if ("value" in element) {
      const value = String(element.value || "");
      setElementValue(element, value + String(text));
      return;
    }
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: String(text), inputType: "insertText" }));
    document.execCommand?.("insertText", false, String(text));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(text), inputType: "insertText" }));
  };
  const nearestScrollable = (element) => {
    let current = isElement(element) ? element : null;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canScrollY = current.scrollHeight > current.clientHeight && !["hidden", "clip"].includes(overflowY);
      const canScrollX = current.scrollWidth > current.clientWidth && !["hidden", "clip"].includes(overflowX);
      if (canScrollY || canScrollX) return current;
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const scrollTargetByNode = (element) => nearestScrollable(element);
  const scrollTargetByPoint = (payload) => nearestScrollable(elementAtPoint(payload, { defaultToCenter: true }));
  const scrollByTarget = (target, left, top) => {
    if (!target) return;
    if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
      window.scrollBy({ left, top, behavior: "instant" });
      return;
    }
    target.scrollBy({ left, top, behavior: "instant" });
  };
  const scrollToTarget = (target, left, top) => {
    if (!target) return;
    if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
      window.scrollTo({ left, top, behavior: "instant" });
      return;
    }
    target.scrollTo({ left, top, behavior: "instant" });
  };
  const deltaFor = (payload, primary, aliases, fallback = 0) => {
    const keys = [primary, ...aliases];
    for (const key of keys) {
      const value = Number(payload[key]);
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  };
  const dispatchKey = (key) => {
    const keyText = String(key);
    const normalizedKey = keyText.split("+").pop();
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyText }));
    const scrollingTarget = nearestScrollable(target);
    const pageY = Math.max(1, Math.round(window.innerHeight * 0.85));
    const lineY = 80;
    if (normalizedKey === "End") {
      scrollToTarget(scrollingTarget, scrollingTarget.scrollLeft ?? window.scrollX, scrollingTarget.scrollHeight ?? document.documentElement.scrollHeight);
    } else if (normalizedKey === "Home") {
      scrollToTarget(scrollingTarget, scrollingTarget.scrollLeft ?? window.scrollX, 0);
    } else if (normalizedKey === "PageDown") {
      scrollByTarget(scrollingTarget, 0, pageY);
    } else if (normalizedKey === "PageUp") {
      scrollByTarget(scrollingTarget, 0, -pageY);
    } else if (normalizedKey === "ArrowDown") {
      scrollByTarget(scrollingTarget, 0, lineY);
    } else if (normalizedKey === "ArrowUp") {
      scrollByTarget(scrollingTarget, 0, -lineY);
    } else if (normalizedKey === " " || normalizedKey === "Space" || normalizedKey === "Spacebar") {
      scrollByTarget(scrollingTarget, 0, keyText.includes("Shift") ? -pageY : pageY);
    }
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: keyText }));
  };
  const waitFor = async (predicate, timeoutMs) => {
    const timeout = Math.max(0, Math.min(Number(timeoutMs) || 5000, 30000));
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeout) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const elementAtPoint = (payload, options = {}) => {
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (options.defaultToCenter) {
        const centered = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
        if (isElement(centered)) return centered;
        return document.body;
      }
      throw new Error("Coordinate operation requires numeric x and y.");
    }
    const element = document.elementFromPoint(x, y);
    if (!isElement(element)) throw new Error("No element exists at the requested coordinate.");
    return element;
  };
  const dispatchMouseAt = (type, payload, detail = 1) => {
    const element = elementAtPoint(payload);
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: Number(payload.x),
        clientY: Number(payload.y),
        detail,
      })
    );
    return element;
  };
`;
}

export function buildBrowserDomSnapshotScript(): string {
  return `(() => {
${buildBrowserBridgeRuntimeScript()}
  return collectVisibleDom();
})()`;
}

export function buildBrowserPlaywrightDomSnapshotScript(): string {
  return `(() => {
${buildBrowserBridgeRuntimeScript()}
  return collectDomSnapshotText();
})()`;
}

export function buildBrowserClickScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element matched selector: " + selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  if (typeof element.click !== "function") throw new Error("Matched element cannot be clicked.");
  element.click();
  const rect = element.getBoundingClientRect();
  return {
    clicked: true,
    element: {
      boundingBox: {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      },
    },
    selector,
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
  };
})()`;
}

export function buildBrowserFillScript(selector: string, value: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const value = ${JSON.stringify(value)};
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element matched selector: " + selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  if (!("value" in element)) throw new Error("Matched element cannot be filled.");
  element.focus?.();
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  const rect = element.getBoundingClientRect();
  return {
    filled: true,
    element: {
      boundingBox: {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      },
    },
    selector,
    tag: element.tagName.toLowerCase(),
    value,
  };
})()`;
}

export function buildBrowserSelectorTargetScript(selector: string): string {
  return `(() => {
${buildBrowserBridgeRuntimeScript()}
  const selector = ${JSON.stringify(selector)};
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element matched selector: " + selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  return { element: describeElement(element), selector };
})()`;
}

export function buildBrowserLocatorTargetScript(args: Record<string, unknown>): string {
  const payload = serializeBridgePayload(args);
  return `(() => {
${buildBrowserBridgeRuntimeScript()}
  const payload = ${payload};
  const element = resolveOneLocatorElement(payload);
  element.scrollIntoView({ block: "center", inline: "center" });
  return { element: describeElement(element) };
})()`;
}

export function buildBrowserLocatorActionScript(
  action: string,
  args: Record<string, unknown>,
): string {
  const payload = serializeBridgePayload(args);
  return `(async () => {
${buildBrowserBridgeRuntimeScript()}
  const payload = ${payload};
  const action = ${JSON.stringify(action)};
  if (action === "count") {
    return { count: resolveLocatorElements(payload).length };
  }
  if (action === "wait_for") {
    const matched = await waitFor(() => {
      const elements = resolveLocatorElements(payload);
      const state = payload.state || "visible";
      if (state === "hidden" || state === "detached") return elements.length === 0;
      return elements.length > 0;
    }, payload.timeoutMs || payload.timeout_ms);
    if (!matched) throw new Error("Timed out waiting for locator.");
    return { ok: true };
  }
  const element = resolveOneLocatorElement(payload);
  if (action === "text_content") return { textContent: element.textContent ?? null };
  if (action === "inner_text") return { innerText: textFor(element) };
  if (action === "get_attribute") {
    const name = payload.name || payload.attribute || payload.value;
    if (typeof name !== "string" || !name) throw new Error("get_attribute requires an attribute name.");
    return { attribute: name, value: element.getAttribute(name) };
  }
  if (action === "is_visible") return { visible: isVisible(element) };
  if (action === "is_enabled") return { enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true" };
  if (action === "click") {
    clickElement(element, 1);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "dblclick") {
    clickElement(element, 2);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "fill") {
    setElementValue(element, String(payload.value ?? payload.text ?? ""));
    return { ok: true, element: describeElement(element) };
  }
  if (action === "press") {
    element.focus?.();
    dispatchKey(payload.value || payload.key || payload.text || "Enter");
    return { ok: true, element: describeElement(element) };
  }
  if (action === "select_option") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("Matched element is not a select.");
    const wanted = payload.value ?? payload.label ?? payload.text;
    const option = Array.from(element.options).find((item) =>
      String(item.value) === String(wanted) || String(item.label) === String(wanted) || String(item.text) === String(wanted)
    );
    if (!option) throw new Error("No option matched select value.");
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: element.value, element: describeElement(element) };
  }
  if (action === "set_checked") {
    if (!("checked" in element)) throw new Error("Matched element cannot be checked.");
    element.checked = payload.checked !== false;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: element.checked, element: describeElement(element) };
  }
  throw new Error("Unsupported locator action: " + action);
})()`;
}

export function buildBrowserDomCuaActionScript(
  action: string,
  args: Record<string, unknown>,
): string {
  const payload = serializeBridgePayload(args);
  return `(async () => {
${buildBrowserBridgeRuntimeScript()}
  const payload = ${payload};
  const action = ${JSON.stringify(action)};
  if (action === "get_visible_dom") return collectVisibleDom();
  const element = payload.node_id || payload.nodeId ? nodeById(payload.node_id || payload.nodeId) : document.activeElement;
  if (action === "scroll") {
    const x = deltaFor(payload, "x", ["scrollX", "scroll_x", "deltaX", "delta_x"]);
    const y = deltaFor(payload, "y", ["scrollY", "scroll_y", "deltaY", "delta_y"]);
    const target = payload.node_id || payload.nodeId ? scrollTargetByNode(element) : (document.scrollingElement || document.documentElement);
    scrollByTarget(target, x, y);
    return {
      ok: true,
      ...(isElement(element) && element !== document.body ? { element: describeElement(element) } : {}),
      viewport: { height: window.innerHeight, width: window.innerWidth },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    };
  }
  if (!element || element === document.body) throw new Error("No DOM target is available.");
  if (action === "click") {
    clickElement(element, 1);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "double_click") {
    clickElement(element, 2);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "type") {
    element.focus?.();
    typeIntoActiveElement(payload.text || "");
    return { ok: true, element: describeElement(element) };
  }
  if (action === "keypress") {
    element.focus?.();
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.value || payload.key || "Enter"];
    for (const key of keys) dispatchKey(key);
    return { ok: true, element: describeElement(element) };
  }
  throw new Error("Unsupported DOM CUA action: " + action);
})()`;
}

export function buildBrowserDomCuaTargetScript(
  action: string,
  args: Record<string, unknown>,
): string {
  const payload = serializeBridgePayload(args);
  return `(() => {
${buildBrowserBridgeRuntimeScript()}
  const payload = ${payload};
  const action = ${JSON.stringify(action)};
  const element =
    action === "scroll" && !(payload.node_id || payload.nodeId)
      ? elementAtPoint(payload, { defaultToCenter: true })
      : payload.node_id || payload.nodeId
        ? nodeById(payload.node_id || payload.nodeId)
        : document.activeElement;
  if (!element || element === document.body) {
    return { ok: true };
  }
  if (isElement(element)) {
    if (action !== "scroll" || payload.node_id || payload.nodeId) {
      element.scrollIntoView?.({ block: "center", inline: "center" });
    }
    return { element: describeElement(element), ok: true };
  }
  return { ok: true };
})()`;
}

export function buildBrowserCuaActionScript(action: string, args: Record<string, unknown>): string {
  const payload = serializeBridgePayload(args);
  return `(async () => {
${buildBrowserBridgeRuntimeScript()}
  const payload = ${payload};
  const action = ${JSON.stringify(action)};
  if (action === "click") {
    const element = dispatchMouseAt("mousedown", payload, 1);
    dispatchMouseAt("mouseup", payload, 1);
    clickElement(element, 1);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "double_click") {
    const element = elementAtPoint(payload);
    clickElement(element, 2);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "move") {
    const element = dispatchMouseAt("mousemove", payload, 0);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "drag") {
    const path = Array.isArray(payload.path) ? payload.path : [];
    if (path.length < 2) throw new Error("drag requires a path with at least two points.");
    dispatchMouseAt("mousedown", path[0], 1);
    for (const point of path.slice(1, -1)) dispatchMouseAt("mousemove", point, 0);
    dispatchMouseAt("mouseup", path[path.length - 1], 1);
    return { ok: true };
  }
  if (action === "scroll") {
    const element = elementAtPoint(payload, { defaultToCenter: true });
    const hasCoordinate = Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y));
    const scrollX = deltaFor(payload, "scrollX", ["scroll_x", "deltaX", "delta_x"]);
    const scrollY = deltaFor(
      payload,
      "scrollY",
      ["scroll_y", "deltaY", "delta_y"],
      hasCoordinate ? 0 : Number(payload.y) || 0
    );
    scrollByTarget(scrollTargetByPoint(payload), scrollX, scrollY);
    return { ok: true, element: describeElement(element) };
  }
  if (action === "type") {
    typeIntoActiveElement(payload.text || "");
    return { ok: true };
  }
  if (action === "keypress") {
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.value || payload.key || "Enter"];
    for (const key of keys) dispatchKey(key);
    return { ok: true };
  }
  throw new Error("Unsupported CUA action: " + action);
})()`;
}

export function buildBrowserClipboardActionScript(
  action: "read_text" | "write_text",
  args: Record<string, unknown>,
): string {
  const payload = serializeBridgePayload(args);
  return `(async () => {
    const payload = ${payload};
    if (!navigator.clipboard) throw new Error("Browser clipboard API is not available.");
    if (${JSON.stringify(action)} === "read_text") {
      return { text: await navigator.clipboard.readText() };
    }
    await navigator.clipboard.writeText(String(payload.text ?? payload.value ?? ""));
    return { ok: true };
  })()`;
}
