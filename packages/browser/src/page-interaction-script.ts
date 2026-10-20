/*
 * The script that watches a page for a remote view, run once per document in ace's own isolated
 * world (`ace-page`). It shares the DOM with the page but none of its JavaScript: the page can
 * neither see these listeners and globals nor call the binding it reports through. It runs in
 * the top frame only, so every box it reports is in the viewport's coordinates.
 *
 * Reports are JSON strings, each one part of the page state:
 *   {kind:"focus", focus}      the focused editable element, or null
 *   {kind:"cursor", cursor}    the CSS cursor under the pointer, when it changes
 *   {kind:"tooltip", tooltip}  a `title` after the pointer rests 500 ms, or null
 *   {kind:"picker", picker}    a select, date, time or colour picker the person opened, or null
 *
 * Opening a picker is intercepted where the engine would open its own popup (a select's
 * mousedown, a date or colour input's click, a select's opening keys), so that popup never
 * opens; the page's handlers still see the event, marked defaultPrevented. `pick(seq, values)`
 * sets the chosen value with this world's native setters (a framework's patched setter on the
 * element doesn't see it, so it notices the change) and fires `input` and `change`.
 */

export const pageWorld = "ace-page";
export const pageBinding = "__acePage";
/** The function `pick` calls in the page world. */
export const pickFunction = "__acePagePick";

export const pageInteractionSource = `(() => {
  if (globalThis.__acePageOn) return;
  globalThis.__acePageOn = true;
  if (window !== window.top) return;
  const send = globalThis[${JSON.stringify(pageBinding)}];
  if (typeof send !== "function") return;
  const post = (message) => { try { send(JSON.stringify(message)); } catch {} };
  const box = (r) => ({
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
  });
  const origin = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    return path.length ? path[0] : event.target;
  };
  const element = (node) => node && node.nodeType === 1 ? node : node && node.parentElement;
  const textTypes = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
  const editable = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el.localName === "textarea") return el.disabled || el.readOnly ? "" : "textarea";
    if (el.localName === "input") {
      const type = String(el.type || "text").toLowerCase();
      return textTypes.has(type) && !el.disabled && !el.readOnly ? type : "";
    }
    return el.isContentEditable ? "contenteditable" : "";
  };
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  // Focus: the editable element that has focus, with its caret where the page can tell it.
  let lastFocus = "", focusTimer = 0;
  const focusNow = () => {
    focusTimer = 0;
    const el = deepActive();
    const type = editable(el);
    let focus = null;
    if (type) {
      focus = { type, rect: box(el.getBoundingClientRect()) };
      if (type === "contenteditable") {
        const selection = getSelection();
        if (selection && selection.rangeCount) {
          const caret = selection.getRangeAt(0).getBoundingClientRect();
          if (caret.width || caret.height) focus.caret = box(caret);
        }
      }
      const mode = el.getAttribute("inputmode");
      if (mode) focus.inputMode = mode.slice(0, 32);
      const hint = el.getAttribute("enterkeyhint");
      if (hint) focus.enterKeyHint = hint.slice(0, 32);
    }
    const text = JSON.stringify(focus);
    if (text === lastFocus) return;
    lastFocus = text;
    post({ kind: "focus", focus });
  };
  const focusSoon = () => { if (!focusTimer) focusTimer = setTimeout(focusNow, 50); };
  document.addEventListener("focusin", focusSoon, true);
  document.addEventListener("focusout", focusSoon, true);
  document.addEventListener("selectionchange", () => { if (lastFocus !== "null" && lastFocus) focusSoon(); }, true);
  for (const type of ["scroll", "resize"])
    addEventListener(type, () => { if (lastFocus !== "null" && lastFocus) focusSoon(); }, { capture: true, passive: true });

  // Cursor: the declared cursor, else what the engine shows for "auto".
  let lastCursor = "", cursorTimer = 0, moved = null;
  const overText = (el, x, y) => {
    if (!document.caretRangeFromPoint) return false;
    if (getComputedStyle(el).userSelect === "none") return false;
    const range = document.caretRangeFromPoint(x, y);
    const node = range && range.startContainer;
    if (!node || node.nodeType !== 3 || !node.data.trim()) return false;
    const at = Math.min(range.startOffset, node.data.length - 1);
    for (const start of [at - 1, at]) {
      if (start < 0) continue;
      const glyph = document.createRange();
      glyph.setStart(node, start);
      glyph.setEnd(node, Math.min(node.data.length, start + 1));
      for (const r of glyph.getClientRects())
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  };
  const cursorAt = (el, x, y) => {
    if (!el) return "default";
    const declared = String(getComputedStyle(el).cursor || "auto").split(",").pop().trim();
    if (declared && declared !== "auto") return declared;
    if (editable(el)) return "text";
    if (el.closest("a[href], area[href]")) return "pointer";
    return overText(el, x, y) ? "text" : "default";
  };
  const cursorNow = () => {
    cursorTimer = 0;
    const event = moved;
    moved = null;
    if (!event) return;
    let cursor = "default";
    try { cursor = cursorAt(element(origin(event)), event.clientX, event.clientY); } catch {}
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    post({ kind: "cursor", cursor });
  };

  // Tooltip: the nearest title over the pointer, once it rests.
  let tipText = "", tipTimer = 0, tipShown = false;
  const tipClear = () => {
    clearTimeout(tipTimer);
    tipTimer = 0;
    tipText = "";
    if (!tipShown) return;
    tipShown = false;
    post({ kind: "tooltip", tooltip: null });
  };
  const titleOf = (event) => {
    for (const node of event.composedPath ? event.composedPath() : [])
      if (node && node.nodeType === 1 && node.hasAttribute("title"))
        return String(node.getAttribute("title")).trim();
    return "";
  };
  addEventListener("mousemove", (event) => {
    moved = event;
    if (!cursorTimer) cursorTimer = setTimeout(cursorNow, 30);
    const text = titleOf(event);
    if (text !== tipText) tipClear();
    if (!text || tipShown) return;
    tipText = text;
    clearTimeout(tipTimer);
    const x = event.clientX, y = event.clientY;
    tipTimer = setTimeout(() => {
      tipTimer = 0;
      tipShown = true;
      post({ kind: "tooltip", tooltip: { text: text.slice(0, 1024), x, y } });
    }, 500);
  }, { capture: true, passive: true });
  for (const type of ["mousedown", "keydown", "wheel", "scroll"])
    addEventListener(type, tipClear, { capture: true, passive: true });

  // Pickers.
  const dateTypes = new Set(["date", "time", "datetime-local", "month", "week", "color"]);
  const pickerKind = (el) => {
    if (!el || el.nodeType !== 1 || el.disabled) return "";
    if (el.localName === "select") return el.multiple || el.size > 1 ? "" : "select";
    if (el.localName !== "input" || el.readOnly) return "";
    const type = String(el.type || "").toLowerCase();
    return dateTypes.has(type) ? type : "";
  };
  let open = null, seq = 0;
  const report = (el, kind) => {
    open = { el, seq: ++seq };
    const picker = { seq, kind, rect: box(el.getBoundingClientRect()), value: String(el.value) };
    if (kind === "select")
      picker.options = [...el.options].slice(0, 1000).map((option) => {
        const group = option.parentElement && option.parentElement.localName === "optgroup"
          ? option.parentElement : null;
        const entry = { value: option.value, label: String(option.label || option.text).slice(0, 512) };
        if (option.disabled || (group && group.disabled)) entry.disabled = true;
        if (group && group.label) entry.group = String(group.label).slice(0, 512);
        return entry;
      });
    else
      for (const name of ["min", "max", "step"]) {
        const value = el.getAttribute(name);
        if (value) picker[name] = value.slice(0, 64);
      }
    post({ kind: "picker", picker });
  };
  const close = () => {
    if (!open) return;
    open = null;
    post({ kind: "picker", picker: null });
  };
  const selectOf = (node) => {
    const el = element(node);
    return el && el.localName === "option" ? el.closest("select") : el;
  };
  addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const el = selectOf(origin(event));
    if (pickerKind(el) !== "select") return;
    event.preventDefault();
    el.focus();
    report(el, "select");
  }, true);
  addEventListener("click", (event) => {
    const el = element(origin(event));
    const kind = pickerKind(el);
    if (!kind || kind === "select") return;
    event.preventDefault();
    report(el, kind);
  }, true);
  addEventListener("keydown", (event) => {
    const el = deepActive();
    if (pickerKind(el) !== "select") return;
    const opens = event.key === " " || event.key === "F4" ||
      (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"));
    if (!opens) return;
    event.preventDefault();
    report(el, "select");
  }, true);
  document.addEventListener("focusout", (event) => {
    if (open && origin(event) === open.el) setTimeout(() => {
      if (open && deepActive() !== open.el) close();
    }, 0);
  }, true);
  addEventListener("pagehide", close, true);
  globalThis[${JSON.stringify(pickFunction)}] = (which, values) => {
    if (!open || open.seq !== which) return "gone";
    const el = open.el;
    open = null;
    post({ kind: "picker", picker: null });
    if (!el.isConnected) return "gone";
    if (!Array.isArray(values) || !values.length) return "dismissed";
    const before = String(el.value);
    if (el.localName === "select") {
      const index = [...el.options].findIndex((option) => option.value === String(values[0]) && !option.disabled);
      if (index < 0) return "invalid";
      el.selectedIndex = index;
    } else el.value = String(values[0]);
    if (String(el.value) === before) return "unchanged";
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "set";
  };
})();`;
