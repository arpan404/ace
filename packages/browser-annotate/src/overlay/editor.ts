import { button, clamp, h, place } from "./dom.ts";
import { icon } from "./icons.ts";

export interface EditorCallbacks {
  save(comment: string): void;
  cancel(): void;
  remove(): void;
  /** Phase 3 style inspector; the sliders button appears only when this is provided. */
  inspect?: () => void;
}

const width = 320;
const gap = 16;

/**
 * The comment pill beside a marker. New annotations get a single line that saves on Enter;
 * reopening one adds delete, Cancel and Save. Keyboard events reach it through the intercept
 * layer (`ui`), because page listeners must never see the person's typing.
 */
export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks) {
  const field = h("textarea", {
    attrs: { rows: "1", maxlength: "4000", placeholder: "Add a comment…", "aria-label": "Comment" },
  });
  field.spellcheck = true;
  const submit = button("submit", "Save comment", [icon("send")], () => commit());
  const save = button("pill primary", "Save", [], () => commit());
  save.textContent = "Save";
  const cancel = button("pill ghost", "Cancel", [], () => callbacks.cancel());
  cancel.textContent = "Cancel";
  const trash = button("icon-button danger", "Delete annotation", [icon("trash")], () =>
    callbacks.remove(),
  );
  const row = h("div", { class: "row" });
  if (callbacks.inspect)
    row.append(button("icon-button", "Edit styles", [icon("sliders")], callbacks.inspect));
  row.append(field, submit);
  const actions = h("div", { class: "actions" }, [
    trash,
    h("div", { class: "spacer" }),
    cancel,
    save,
  ]);
  const root = h(
    "div",
    { class: "editor glass", attrs: { role: "dialog", "aria-label": "Annotation" } },
    [row, actions],
  );
  let open = false;
  let editing = false;
  let anchor: { x: number; y: number } | null = null;

  function content(): string {
    return field.value.trim();
  }
  function refresh(): void {
    place(field, { height: "28px" });
    place(field, { height: `${Math.min(Math.max(field.scrollHeight, 28), 112)}px` });
    submit.disabled = !content();
    save.disabled = !content();
    layout();
  }
  function commit(): void {
    if (content()) callbacks.save(content());
  }
  function layout(): void {
    if (!open || !anchor) return;
    const height = root.offsetHeight || 38;
    const right = anchor.x + gap + width <= innerWidth - 8;
    const left = right ? anchor.x + gap : anchor.x - gap - width;
    place(root, {
      translate: `${clamp(left, 8, innerWidth - width - 8)}px ${clamp(anchor.y - 19, 8, innerHeight - height - 8)}px`,
    });
  }
  return {
    get open() {
      return open;
    },
    get dirty() {
      return open && content().length > 0;
    },
    text: content,
    /** Open beside the marker at `at` (viewport px) and focus the comment. */
    show(mode: "new" | "edit", text: string, at: { x: number; y: number } | null): void {
      editing = mode === "edit";
      anchor = at;
      root.classList.remove("concealed");
      root.classList.toggle("editing", editing);
      submit.hidden = editing;
      actions.hidden = !editing;
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
      root.remove();
    },
    /** Viewport point of the marker this editor belongs to; null hides it while off screen. */
    follow(point: { x: number; y: number } | null): void {
      if (!open) return;
      anchor = point;
      root.classList.toggle("concealed", !point);
      layout();
    },
    conceal(hidden: boolean): void {
      if (open) root.classList.toggle("concealed", hidden || !anchor);
    },
    contains(node: Node): boolean {
      return root.contains(node);
    },
    ui(event: Event): void {
      // `:focus` needs window focus, which a background page may lack; the root's focus does not.
      const scope = field.getRootNode();
      if (!open || !(scope instanceof ShadowRoot) || scope.activeElement !== field) return;
      if (event.type === "input") refresh();
      if (!(event instanceof KeyboardEvent) || event.type !== "keydown") return;
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        callbacks.cancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    },
  };
}
export type Editor = ReturnType<typeof createEditor>;
