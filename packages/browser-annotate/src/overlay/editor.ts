import { button, clamp, h, place } from "./dom.ts";
import { icon } from "./icons.ts";
import type { MarkerPlace } from "./markers.ts";

export interface EditorCallbacks {
  save(comment: string): void;
  cancel(): void;
  remove(): void;
  /** The sliders button: open or close the style inspector. */
  inspect(): void;
  /** Typing in a control outside the comment field; true when it was handled. */
  ui(event: Event, focused: Element): boolean;
}

const width = 320;
const wideWidth = 344;
const gap = 16;

/**
 * The comment pill beside a marker. New annotations get a single line that saves on Enter;
 * reopening one adds delete, Cancel and Save, and so does opening the style inspector, which
 * the editor hosts below the comment. Keyboard events reach it through the intercept layer
 * (`ui`), because page listeners must never see the person's typing.
 */
export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks) {
  const field = h("textarea", {
    attrs: { rows: "1", maxlength: "4000", placeholder: "Add a comment…", "aria-label": "Comment" },
  });
  field.spellcheck = true;
  const sliders = button("icon-button", "Edit styles", [icon("sliders")], () =>
    callbacks.inspect(),
  );
  sliders.setAttribute("aria-expanded", "false");
  const submit = button("submit", "Save comment", [icon("send")], () => commit());
  const save = button("pill primary", "Save", [], () => commit());
  save.textContent = "Save";
  const cancel = button("pill ghost", "Cancel", [], () => callbacks.cancel());
  cancel.textContent = "Cancel";
  const trash = button("icon-button danger", "Delete annotation", [icon("trash")], () =>
    callbacks.remove(),
  );
  const slot = h("div", { class: "slot" });
  const actions = h("div", { class: "actions" }, [
    trash,
    h("div", { class: "spacer" }),
    cancel,
    save,
  ]);
  const root = h(
    "div",
    { class: "editor glass", attrs: { role: "dialog", "aria-label": "Annotation" } },
    [h("div", { class: "row" }, [sliders, field, submit]), slot, actions],
  );
  let open = false;
  let editing = false;
  let expanded = false;
  let edited = false;
  let anchor: MarkerPlace | null = null;
  /** Where the person dragged the panel to; it stops following the marker until closed. */
  let moved: { x: number; y: number } | undefined;

  function content(): string {
    return field.value.trim();
  }
  function refresh(): void {
    place(field, { height: "28px" });
    place(field, { height: `${Math.min(Math.max(field.scrollHeight, 28), 112)}px` });
    const ready = !!content() || edited;
    submit.disabled = !ready;
    save.disabled = !ready;
    layout();
  }
  function chrome(): void {
    root.classList.toggle("editing", editing || expanded);
    root.classList.toggle("wide", expanded);
    submit.hidden = editing || expanded;
    actions.hidden = !editing && !expanded;
    trash.hidden = !editing;
    sliders.classList.toggle("on", expanded);
    sliders.setAttribute("aria-expanded", String(expanded));
  }
  function commit(): void {
    if (content() || edited) callbacks.save(content());
  }
  function layout(): void {
    if (!open) return;
    const size = expanded ? wideWidth : width;
    const height = root.offsetHeight || 38;
    if (moved) {
      place(root, {
        translate: `${clamp(moved.x, 8, innerWidth - size - 8)}px ${clamp(moved.y, 8, innerHeight - height - 8)}px`,
      });
      return;
    }
    if (!anchor) return;
    // Keep the element in view for its live previews: below it, else above its marker, else
    // beside the marker when the element fills the viewport.
    // A region's marker overhangs its bottom-right corner: the panel clears it and ends there.
    const below = anchor.bottom + (anchor.end ? 11 : 0) + gap / 2;
    const above = (anchor.end ? anchor.top : anchor.y - 11) - gap / 2 - height;
    const edge = clamp(anchor.end ? anchor.x + 11 - size : anchor.x - 11, 8, innerWidth - size - 8);
    let left: number;
    let top: number;
    if (below + height <= innerHeight - 8) [left, top] = [edge, below];
    else if (above >= 8) [left, top] = [edge, above];
    else {
      const right = anchor.x + gap + size <= innerWidth - 8;
      left = clamp(right ? anchor.x + gap : anchor.x - gap - size, 8, innerWidth - size - 8);
      top = clamp(anchor.y - 19, 8, innerHeight - height - 8);
    }
    place(root, { translate: `${left}px ${top}px` });
  }
  return {
    get open() {
      return open;
    },
    get dirty() {
      return open && (content().length > 0 || edited);
    },
    text: content,
    /** Open by the marker and element at `at` (viewport px) and focus the comment. */
    show(mode: "new" | "edit", text: string, at: MarkerPlace | null): void {
      editing = mode === "edit";
      expanded = false;
      edited = false;
      moved = undefined;
      anchor = at;
      slot.replaceChildren();
      root.classList.remove("concealed");
      chrome();
      field.value = text;
      if (!root.isConnected) parent.append(root);
      open = true;
      refresh();
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    },
    hide(): void {
      open = false;
      anchor = null;
      moved = undefined;
      slot.replaceChildren();
      root.remove();
    },
    /** Enable the sliders button, or disable it saying why (a region has no one element). */
    inspectable(reason: string | null): void {
      sliders.disabled = !!reason;
      const label = reason ?? "Edit styles";
      sliders.setAttribute("aria-label", label);
      sliders.title = label;
    },
    /** Host `panel` below the comment (the style inspector), or close it with null. */
    expand(panel: HTMLElement | null): void {
      expanded = !!panel;
      slot.replaceChildren(...(panel ? [panel] : []));
      chrome();
      refresh();
    },
    get expanded() {
      return expanded;
    },
    /** Whether the element shows previewed edits, which can be saved without a comment. */
    edited(value: boolean): void {
      edited = value;
      if (open) refresh();
    },
    /** Let `handle` drag the whole panel. */
    draggable(handle: HTMLElement): void {
      let drag: { pointer: number; dx: number; dy: number } | undefined;
      handle.addEventListener("pointerdown", (event) => {
        if (!event.isTrusted || event.button !== 0) return;
        const box = root.getBoundingClientRect();
        drag = {
          pointer: event.pointerId,
          dx: event.clientX - box.left,
          dy: event.clientY - box.top,
        };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointer) return;
        moved = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
        layout();
      });
      const finish = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointer) return;
        drag = undefined;
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    },
    /** Viewport point of the marker this editor belongs to; null hides it while off screen. */
    follow(point: MarkerPlace | null): void {
      if (!open) return;
      anchor = point;
      root.classList.toggle("concealed", !point && !moved);
      layout();
    },
    conceal(hidden: boolean): void {
      if (open) root.classList.toggle("concealed", hidden || (!anchor && !moved));
    },
    contains(node: Node): boolean {
      return root.contains(node);
    },
    ui(event: Event): void {
      // `:focus` needs window focus, which a background page may lack; the root's focus does not.
      const scope = root.getRootNode();
      if (!open || !(scope instanceof ShadowRoot)) return;
      const focused = scope.activeElement;
      if (!focused || !root.contains(focused)) return;
      if (focused !== field && callbacks.ui(event, focused)) return;
      if (focused === field && event.type === "input") refresh();
      if (!(event instanceof KeyboardEvent) || event.type !== "keydown") return;
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        callbacks.cancel();
      } else if (
        (focused === field || (focused instanceof HTMLInputElement && focused.type === "text")) &&
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        // Enter saves from the comment and from any inspector value, as in the comment pill.
        event.preventDefault();
        commit();
      }
    },
  };
}
export type Editor = ReturnType<typeof createEditor>;
