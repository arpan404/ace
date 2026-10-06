import type { ThreadListEntry } from "@ace/protocol";
import {
  dropTargetAt,
  indicatorAt,
  moveTargets,
  placePinned,
  sameTarget,
  stepTarget,
  type DropTarget,
  type PinnedPlace,
  type RowBox,
} from "@ace/ui-core";
import type { ThreadActions } from "@/features/organize/index.ts";

/*
 * Moving Home threads into, within and out of the Pinned group, by pointer or keyboard. Loaded
 * on first use, so the first paint doesn't carry it. Pure geometry and placement come from
 * @ace/ui-core (`dropTargetAt`, `placePinned`); this is the thin DOM shell: a ghost of the row
 * under the pointer, a line where it would land, scrolling near the edges, and words for
 * assistive tech. Native pointer events, no library: the whole thing is a few KB.
 */

/** What the list lends a move: its elements, its rows as measured, its pinned group, commands. */
export interface DragHost {
  viewport: HTMLElement;
  list: HTMLElement;
  boxes(): RowBox[];
  /** The Pinned group as shown, top first. */
  pinned(): PinnedPlace[];
  entry(id: string): ThreadListEntry | undefined;
  actions: ThreadActions;
  /** Moving rows dim, and an empty Pinned group shows its drop zone; undefined ends it. */
  setMoving(ids: readonly string[] | undefined): void;
  announce(text: string): void;
}

/** Pointer travel before a press becomes a drag, so a click stays a click. */
const threshold = 5;
/** Within this distance of the list's top or bottom edge a drag scrolls it. */
const edge = 48;
const maxScroll = 16;

function nameOf(host: DragHost, ids: readonly string[]): string {
  if (ids.length > 1) return `${ids.length} threads`;
  return host.entry(ids[0] ?? "")?.title ?? "Thread";
}

/** Words for where a drop would land, for the live region. */
function describe(host: DragHost, ids: readonly string[], target: DropTarget): string {
  const name = nameOf(host, ids);
  const moving = new Set(ids);
  if (target.kind === "unpin") {
    const pinned = host.pinned().some((pin) => moving.has(pin.id));
    return pinned ? `${name}: unpin` : `${name}: not pinned`;
  }
  const others = host.pinned().filter((pin) => !moving.has(pin.id)).length;
  return `${name}: Pinned, place ${target.index + 1} of ${others + 1}`;
}

/** Pin the threads at `target`, or unpin them; nothing when it changes nothing. */
function drop(host: DragHost, ids: readonly string[], target: DropTarget): string | undefined {
  const entries = ids.flatMap((id) => host.entry(id) ?? []);
  if (target.kind === "unpin") {
    const pinned = entries.filter((entry) => entry.pinned === true);
    const [only] = pinned;
    if (pinned.length === 1 && only) host.actions.setPinned(only, false);
    else if (pinned.length) host.actions.setPinnedMany(pinned, false);
    return pinned.length ? `Unpinned ${nameOf(host, ids)}` : undefined;
  }
  const moves = placePinned(
    host.pinned(),
    entries.map((entry) => entry.id),
    target.index,
  );
  host.actions.placePinned(
    moves.flatMap((move) => {
      const entry = host.entry(move.id);
      return entry ? [{ entry, order: move.order }] : [];
    }),
  );
  return moves.length ? `Dropped ${describe(host, ids, target)}` : undefined;
}

/** The line where a drop lands, with a word when it unpins. Drawn in the list's coordinates. */
function indicator(list: HTMLElement) {
  const line = document.createElement("div");
  line.setAttribute("aria-hidden", "true");
  line.dataset.dropIndicator = "";
  Object.assign(line.style, {
    position: "absolute",
    left: "6px",
    right: "6px",
    top: "-1px",
    height: "2px",
    borderRadius: "1px",
    background: "var(--ring)",
    pointerEvents: "none",
    zIndex: "3",
    transition: "transform var(--dur-1) var(--ease-smooth, ease-out)",
  });
  const label = document.createElement("span");
  label.className = "rounded-sm bg-popover px-1.5 text-xs font-medium text-foreground";
  Object.assign(label.style, {
    position: "absolute",
    right: "0",
    top: "-9px",
    boxShadow: "0 0 0 1px var(--ring)",
  });
  line.append(label);
  let shown = false;
  return {
    show(y: number, word: string | undefined) {
      line.style.transform = `translateY(${y}px)`;
      label.textContent = word ?? "";
      label.hidden = !word;
      if (!shown) list.append(line);
      shown = true;
    },
    hide() {
      line.remove();
      shown = false;
    },
  };
}

/** A copy of the row that follows the pointer, with how many threads it carries. */
function ghostOf(row: HTMLElement, count: number) {
  const rect = row.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    pointerEvents: "none",
    zIndex: "60",
    borderRadius: "10px",
    background: "var(--popover)",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.22), 0 0 0 1px var(--ring)",
    opacity: "0.95",
  });
  const copy = row.cloneNode(true);
  if (copy instanceof HTMLElement) {
    for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
    ghost.append(copy);
  }
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "rounded-full bg-tint px-1.5 text-xs font-medium text-tint-foreground";
    Object.assign(badge.style, { position: "absolute", right: "-6px", top: "-6px" });
    badge.textContent = String(count);
    ghost.append(badge);
  }
  document.body.append(ghost);
  return {
    move(dy: number) {
      ghost.style.transform = `translate3d(0, ${dy}px, 0)`;
    },
    remove() {
      ghost.remove();
    },
  };
}

function stopClick(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

/** The next click lands at the end of a drag: it must not open the row it ends on. */
function swallowNextClick() {
  window.addEventListener("click", stopClick, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stopClick, { capture: true }), 0);
}

/**
 * Follow a press on a row: past a few pixels it becomes a drag of `ids`. Released over the
 * Pinned group it pins them at the line; below it, it unpins pinned ones. Escape cancels.
 */
export function trackPointer(
  host: DragHost,
  start: { x: number; y: number; pointerId: number; id: string },
  ids: readonly string[],
): void {
  const moving = new Set(ids);
  const row = host.list.querySelector<HTMLElement>(`[data-thread-row="${CSS.escape(start.id)}"]`);
  let dragging = false;
  let y = start.y;
  let target: DropTarget | undefined;
  let frame = 0;
  let ghost: ReturnType<typeof ghostOf> | undefined;
  const line = indicator(host.list);
  const update = () => {
    const listTop = host.list.getBoundingClientRect().top;
    const boxes = host.boxes();
    const next = dropTargetAt(boxes, y - listTop, moving);
    ghost?.move(y - start.y);
    if (next)
      line.show(indicatorAt(boxes, next, moving), next.kind === "unpin" ? "Unpin" : undefined);
    else line.hide();
    if (!sameTarget(next, target) && next) host.announce(describe(host, ids, next));
    target = next;
  };
  const tick = () => {
    frame = 0;
    const rect = host.viewport.getBoundingClientRect();
    const speed =
      y < rect.top + edge
        ? -Math.ceil(((rect.top + edge - y) / edge) * maxScroll)
        : y > rect.bottom - edge
          ? Math.ceil(((y - rect.bottom + edge) / edge) * maxScroll)
          : 0;
    if (speed) host.viewport.scrollTop += speed;
    update();
    // Keep scrolling while the pointer rests near an edge.
    if (speed && dragging) frame = requestAnimationFrame(tick);
  };
  const begin = () => {
    dragging = true;
    host.setMoving(ids);
    if (row) ghost = ghostOf(row, ids.length);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    host.announce(
      `Moving ${nameOf(host, ids)}. Drop it in Pinned to pin it, or below to unpin it.`,
    );
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, { capture: true });
    if (frame) cancelAnimationFrame(frame);
    if (!dragging) return;
    swallowNextClick();
    line.hide();
    ghost?.remove();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    host.setMoving(undefined);
    const said = commit && target ? drop(host, ids, target) : undefined;
    host.announce(said ?? "Move cancelled");
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    // Released before this code had loaded: there is nothing to drag.
    if (!event.buttons) return finish(false);
    y = event.clientY;
    if (!dragging) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < threshold) return;
      begin();
    }
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    if (dragging) update();
    finish(true);
  };
  const onCancel = () => finish(false);
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !dragging) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, { capture: true });
}

/** A keyboard move under way: the list hands it every key until it ends. */
export interface KeyboardMove {
  /** Handle one key; true when it was the move's (the list then prevents its default). */
  key(event: KeyboardEvent): boolean;
  active(): boolean;
  cancel(): void;
}

/**
 * Pick `ids` up to move by keyboard: ↑ and ↓ (or k and j) step through the places in the
 * Pinned group and, below it, out of the group; Space or Enter drops; Escape or Tab cancels.
 * Each step is announced, and the line shows where it would land.
 */
export function startKeyboardMove(host: DragHost, ids: readonly string[]): KeyboardMove {
  const moving = new Set(ids);
  const pinned = host.pinned();
  const others = pinned.filter((pin) => !moving.has(pin.id));
  const targets = moveTargets(others.length);
  const first = pinned.findIndex((pin) => moving.has(pin.id));
  const startsPinned = first >= 0;
  let target: DropTarget = startsPinned
    ? { kind: "pin", index: pinned.slice(0, first).filter((pin) => !moving.has(pin.id)).length }
    : { kind: "unpin" };
  let live = true;
  const line = indicator(host.list);
  const show = () => {
    const boxes = host.boxes();
    if (target.kind === "unpin" && !startsPinned) line.hide();
    else {
      const y = indicatorAt(boxes, target, moving);
      line.show(y, target.kind === "unpin" ? "Unpin" : undefined);
      // Keep the line in view as it moves.
      const viewport = host.viewport;
      const top =
        y +
        host.list.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      if (top < viewport.scrollTop + edge) viewport.scrollTop = top - edge;
      else if (top > viewport.scrollTop + viewport.clientHeight - edge)
        viewport.scrollTop = top - viewport.clientHeight + edge;
    }
  };
  const end = (said: string) => {
    live = false;
    line.hide();
    host.setMoving(undefined);
    host.announce(said);
  };
  host.setMoving(ids);
  // The drop zone of an empty Pinned group mounts with the next render: measure after it.
  requestAnimationFrame(() => live && show());
  host.announce(
    `Moving ${nameOf(host, ids)}. ${describe(host, ids, target)}. Up and Down choose a place, Space or Enter drops it, Escape cancels.`,
  );
  return {
    active: () => live,
    cancel: () => {
      if (live) end("Move cancelled");
    },
    key(event) {
      if (!live) return false;
      const step =
        event.key === "ArrowUp" || event.key === "k"
          ? -1
          : event.key === "ArrowDown" || event.key === "j"
            ? 1
            : 0;
      if (step) {
        const next = stepTarget(targets, target, step);
        if (!sameTarget(next, target)) {
          target = next;
          show();
        }
        host.announce(describe(host, ids, target));
        return true;
      }
      if (event.key === " " || event.key === "Enter") {
        end(drop(host, ids, target) ?? "Nothing moved");
        return true;
      }
      if (event.key === "Escape") {
        end("Move cancelled");
        return true;
      }
      if (event.key === "Tab") {
        end("Move cancelled");
        return false;
      }
      // Other plain keys wait: a move ends only by dropping or cancelling. Shortcuts still work.
      return !(event.metaKey || event.ctrlKey || event.altKey);
    },
  };
}
