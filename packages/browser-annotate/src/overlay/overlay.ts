import { createBar } from "./bar.ts";
import { createOutline, createToast } from "./chrome.ts";
import { createEditor } from "./editor.ts";
import { createHost } from "./host.ts";
import { randomId } from "./id.ts";
import { createInspector } from "./inspector.ts";
import { intercept } from "./intercept.ts";
import { createLiveEdits, type EditSnapshot } from "./live-edits.ts";
import { createMarkers, type Anchor } from "./markers.ts";
import { describeElement, elementAt, pointIn } from "./pick.ts";
import { between, createMarquee, describeRegion, regionRect, type Box } from "./region.ts";
import { resolveElement, visibleBox } from "./selector.ts";
import { applyPalette, overlaySheet } from "./theme.ts";
import type {
  OverlayAnnotation,
  OverlayCommand,
  OverlayElement,
  OverlayEvent,
  OverlayHandle,
  OverlayInit,
} from "./types.ts";

/** Mirrors `browserAnnotationLimit` in @ace/protocol; the overlay bundle carries no zod. */
const limit = 20;

interface Pending {
  id: string;
  anchor: Anchor;
  point: { x: number; y: number };
  /** The clicked element, or the element holding a region. */
  description: OverlayElement;
  /** A dragged area's document box and the elements inside it. */
  region?: { box: Box; elements: OverlayElement[] };
}

/** Smallest region side in CSS px; a thinner drag picks the element it started on. */
const minimumRegion = 8;
const noInspector = "Styles are edited on one element; click an element to edit its styles";

/** The element the open editor belongs to, and its edits when the editor opened. */
interface EditSession {
  element: Element;
  snapshot: EditSnapshot;
}

/** Start annotate mode in this document. Every page-visible effect is undone by `teardown`. */
export function startOverlay(init: OverlayInit): OverlayHandle {
  const binding: unknown = Reflect.get(globalThis, init.binding);
  if (typeof binding !== "function") throw new Error("Annotation binding unavailable");
  const emit = (event: OverlayEvent) => {
    Reflect.apply(binding, undefined, [JSON.stringify(event)]);
  };
  const documentId = randomId();
  const { host, layer, dispose: removeHost } = createHost(overlaySheet(init.tokens));
  const records = new Map<string, OverlayAnnotation>();
  let nextNumber = init.config.nextNumber ?? 1;
  let pending: Pending | undefined;
  let editing: string | undefined;
  let pointer: { x: number; y: number } | null = null;
  let capturing = false;
  /** Space is held: the page has the pointer, so nothing is outlined. */
  let using = false;
  let selecting = false;
  let session: EditSession | undefined;
  // Previewed style and text edits stay while annotating and are undone by teardown.
  const live = createLiveEdits();

  const theme = (name: "light" | "dark" | undefined) =>
    applyPalette(layer, init.palettes[name ?? "dark"], name ?? "dark");
  theme(init.config.theme);
  const outline = createOutline(layer);
  const marquee = createMarquee(layer);
  const markers = createMarkers(layer, (id) => openExisting(id));
  const inspector = createInspector(live, () =>
    editor.edited(!!session && live.edited(session.element)),
  );
  const editor = createEditor(layer, {
    save: (comment) => save(comment),
    cancel: () => closeEditor(),
    remove: () => {
      if (!editing) return;
      const id = editing;
      closeEditor();
      drop(id);
      emit({ kind: "removed", id });
    },
    inspect: () => {
      if (!session) return;
      if (editor.expanded) return editor.expand(null);
      inspector.show(session.element);
      editor.expand(inspector.root);
    },
    ui: (event, focused) => inspector.ui(event, focused),
  });
  editor.draggable(inspector.grip);
  const bar = createBar(layer, {
    screenshot: () => emit({ kind: "screenshot" }),
    markers: (hidden) => markers.hidden(hidden),
    discard: () => {
      closeEditor();
      clearAll();
      emit({ kind: "discard" });
    },
    send: () => {
      settleEditor();
      emit({ kind: "send" });
    },
    close: () => {
      settleEditor();
      emit({ kind: "close" });
    },
    moved: (x, y) => emit({ kind: "bar", x, y }),
    original: {
      hold: () => {
        live.hold();
        markers.schedule();
      },
      release: () => {
        live.release();
        markers.schedule();
      },
    },
  });
  live.onChange(() => bar.originalAvailable(live.count > 0));
  const toast = createToast(layer, bar);
  if (init.config.markersHidden) bar.markersHidden(true);
  if (init.config.bar) bar.moveTo(init.config.bar);

  function count(): void {
    bar.count(records.size);
  }
  /** Whether another record or the pending annotation still points at `element`. */
  function shared(element: Element, except: string): boolean {
    if (pending?.anchor.element === element) return true;
    for (const id of records.keys())
      if (id !== except && markers.anchor(id)?.element === element) return true;
    return false;
  }
  /** Remove a record, undo its previews and close the gap in the numbering after it. */
  function drop(id: string): void {
    const record = records.get(id);
    const element = markers.anchor(id)?.element;
    records.delete(id);
    markers.remove(id);
    if (element && !shared(element, id)) live.revert(element);
    if (record) {
      for (const other of [...records.values()].toSorted((a, b) => a.number - b.number)) {
        if (other.number <= record.number) continue;
        const anchor = markers.anchor(other.id);
        const renumbered = { ...other, number: other.number - 1 };
        records.set(other.id, renumbered);
        if (anchor) markers.set(other.id, anchor, renumbered.number);
        emit({ kind: "saved", annotation: renumbered });
      }
      if (record.number < nextNumber) nextNumber = Math.max(1, nextNumber - 1);
    }
    count();
  }
  function clearAll(): void {
    records.clear();
    markers.clear();
    live.revertAll();
    nextNumber = 1;
    count();
  }
  function begin(element: Element): void {
    session = { element, snapshot: live.snapshot(element) };
    editor.edited(live.edited(element));
  }
  function activeId(): string | undefined {
    return pending?.id ?? editing;
  }
  /** Close without saving: previews made since the editor opened are rolled back. */
  function closeEditor(): void {
    if (session) live.rollback(session.element, session.snapshot);
    session = undefined;
    if (pending) markers.remove(pending.id);
    pending = undefined;
    editing = undefined;
    editor.hide();
    markers.schedule();
  }
  /** Leaving the editor keeps a typed new comment; an unsaved edit is dropped. */
  function settleEditor(): void {
    if (pending && editor.dirty) save(editor.text());
    else closeEditor();
  }
  function save(comment: string): void {
    const changes = session ? live.diff(session.element) : { styles: [] };
    session = undefined;
    if (pending) {
      const { id, anchor, point, description, region: area } = pending;
      const record: OverlayAnnotation = {
        id,
        kind: area ? "region" : "element",
        ...(area ? { region: area } : {}),
        number: nextNumber,
        documentId,
        url: location.href.slice(0, 8192),
        title: document.title.slice(0, 1024),
        point,
        comment: comment.slice(0, 4000),
        element: description,
        styles: changes.styles,
        ...(changes.text ? { text: changes.text } : {}),
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio: devicePixelRatio || 1,
          scrollX,
          scrollY,
        },
      };
      nextNumber = Math.min(99, nextNumber + 1);
      pending = undefined;
      records.set(id, record);
      markers.set(id, anchor, record.number);
      editor.hide();
      count();
      emit({ kind: "saved", annotation: record });
      return;
    }
    const record = editing ? records.get(editing) : undefined;
    if (!record) return closeEditor();
    const updated: OverlayAnnotation = {
      ...record,
      comment: comment.slice(0, 4000),
      styles: changes.styles,
    };
    if (changes.text) updated.text = changes.text;
    else delete updated.text;
    records.set(record.id, updated);
    editing = undefined;
    editor.hide();
    emit({ kind: "saved", annotation: updated });
  }
  /** Open the editor for `anchor`; only an element has styles to inspect. */
  function present(mode: "new" | "edit", id: string, text: string, anchor: Anchor): void {
    editor.show(mode, text, markers.position(id));
    editor.inspectable(anchor.element ? null : noInspector);
    if (anchor.element) begin(anchor.element);
    markers.schedule();
  }
  function openExisting(id: string): void {
    const record = records.get(id);
    const anchor = markers.anchor(id);
    if (!record || !anchor || (anchor.element && !anchor.element.isConnected)) return;
    closeEditor();
    editing = id;
    present("edit", id, record.comment, anchor);
  }
  function full(): boolean {
    if (records.size < limit && nextNumber <= 99) return false;
    toast.show(`Up to ${limit} annotations at a time`);
    return true;
  }
  function pick(x: number, y: number): void {
    if (editor.open) return settleEditor();
    const element = elementAt(x, y, host);
    if (!element || full()) return;
    const point = pointIn(element, x, y);
    const anchor = { element };
    pending = { id: randomId(), anchor, point, description: describeElement(element) };
    markers.set(pending.id, anchor);
    present("new", pending.id, "", anchor);
  }
  /** A drag on the page: the marquee follows it; the first move settles an open editor. */
  function drag(box: Box | null): void {
    if (box && !selecting && editor.open) settleEditor();
    selecting = !!box;
    if (box) marquee.show(box);
    else marquee.hide();
    markers.schedule();
  }
  function region(start: { x: number; y: number }, end: { x: number; y: number }): void {
    drag(null);
    const box = between(start, end);
    if (box.width < minimumRegion || box.height < minimumRegion) return pick(start.x, start.y);
    if (full()) return;
    const found = describeRegion(box, host);
    const anchor = { region: found.document };
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const container = elementAt(centre.x, centre.y, host);
    pending = {
      id: randomId(),
      anchor,
      point: container ? pointIn(container, centre.x, centre.y) : { x: 0.5, y: 0.5 },
      description: found.container,
      region: { box: found.document, elements: found.elements },
    };
    markers.set(pending.id, anchor);
    present("new", pending.id, "", anchor);
  }
  markers.onUpdate(() => {
    const id = activeId();
    const hover = !using && !selecting && pointer ? elementAt(pointer.x, pointer.y, host) : null;
    const target = id ? markers.anchor(id)?.element : hover;
    outline.show(capturing ? null : (target ?? null));
    editor.follow(id ? markers.position(id) : null);
  });
  const stopIntercept = intercept(host, {
    pick,
    hover: (x, y) => {
      pointer = { x, y };
      markers.schedule();
    },
    leave: () => {
      pointer = null;
      markers.schedule();
    },
    drag,
    region,
    using: (active) => {
      using = active;
      layer.classList.toggle("using", active);
      markers.schedule();
    },
    ui: (event) => editor.ui(event),
    escape: () => {
      if (editor.open) closeEditor();
    },
  });
  const reflow = () => markers.schedule();
  const listen = { capture: true, passive: true } as const;
  addEventListener("scroll", reflow, listen);
  addEventListener("resize", reflow, listen);
  visualViewport?.addEventListener("resize", reflow);
  visualViewport?.addEventListener("scroll", reflow);
  const mutations = new MutationObserver(reflow);
  mutations.observe(document, { subtree: true, childList: true, attributes: true });

  function restore(annotations: OverlayAnnotation[]): void {
    for (const annotation of annotations) {
      if (records.has(annotation.id) || records.size >= limit) continue;
      if (annotation.kind === "region" && annotation.region) {
        records.set(annotation.id, annotation);
        markers.set(annotation.id, { region: annotation.region.box }, annotation.number);
        nextNumber = Math.min(99, Math.max(nextNumber, annotation.number + 1));
        continue;
      }
      const element = resolveElement(annotation.element.selector, annotation.element.xpath);
      if (!element) continue;
      records.set(annotation.id, annotation);
      markers.set(annotation.id, { element }, annotation.number);
      // Previews come back with their markers, e.g. after the renderer restarted.
      for (const change of annotation.styles) live.set(element, change.property, change.after);
      if (annotation.text) live.setText(element, annotation.text.after);
      nextNumber = Math.min(99, Math.max(nextNumber, annotation.number + 1));
    }
    count();
  }
  function command(input: OverlayCommand): void {
    switch (input.op) {
      case "configure":
        theme(input.theme);
        if (input.nextNumber !== undefined) nextNumber = input.nextNumber;
        if (input.markersHidden !== undefined) bar.markersHidden(input.markersHidden);
        if (input.bar) bar.moveTo(input.bar);
        return;
      case "edit": {
        const anchor = markers.anchor(input.id);
        if (anchor?.element) anchor.element.scrollIntoView({ block: "center", inline: "nearest" });
        else if (anchor?.region) {
          const { x, y, width, height } = anchor.region;
          scrollTo({ left: x + width / 2 - innerWidth / 2, top: y + height / 2 - innerHeight / 2 });
        }
        openExisting(input.id);
        return;
      }
      case "remove":
        if (editing === input.id) closeEditor();
        drop(input.id);
        return;
      case "clear":
        closeEditor();
        clearAll();
        return;
      case "renumber":
        for (const { id, number } of input.numbers) {
          const record = records.get(id);
          const anchor = markers.anchor(id);
          if (!record || !anchor) continue;
          records.set(id, { ...record, number });
          markers.set(id, anchor, number);
        }
        return;
      case "toast":
        toast.show(input.text);
        return;
      case "restore":
        restore(input.annotations);
        return;
    }
  }
  function conceal(hidden: boolean): void {
    capturing = hidden;
    layer.classList.toggle("capturing", hidden);
    bar.conceal(hidden);
    editor.conceal(hidden);
    outline.conceal(hidden);
    toast.conceal(hidden);
  }
  count();
  emit({
    kind: "ready",
    documentId,
    url: location.href.slice(0, 8192),
    title: document.title.slice(0, 1024),
  });
  return {
    documentId,
    command,
    async prepareCapture() {
      conceal(true);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    finishCapture() {
      conceal(false);
      markers.schedule();
    },
    rect(id) {
      const anchor = records.has(id) ? markers.anchor(id) : undefined;
      if (anchor?.region) return regionRect(anchor.region);
      if (!anchor?.element.isConnected) return null;
      return visibleBox(anchor.element);
    },
    viewport() {
      return {
        pageX: visualViewport?.pageLeft ?? scrollX,
        pageY: visualViewport?.pageTop ?? scrollY,
        width: visualViewport?.width ?? innerWidth,
        height: visualViewport?.height ?? innerHeight,
        devicePixelRatio: devicePixelRatio || 1,
      };
    },
    host: () => host,
    teardown() {
      stopIntercept();
      marquee.hide();
      live.revertAll();
      removeEventListener("scroll", reflow, listen);
      removeEventListener("resize", reflow, listen);
      visualViewport?.removeEventListener("resize", reflow);
      visualViewport?.removeEventListener("scroll", reflow);
      mutations.disconnect();
      toast.dispose();
      bar.dispose();
      markers.dispose();
      removeHost();
    },
  };
}
