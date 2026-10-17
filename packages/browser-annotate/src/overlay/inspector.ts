import { button, h, place } from "./dom.ts";
import { icon } from "./icons.ts";
import {
  fontChoices,
  fontWeights,
  hexOf,
  inspectorFields,
  sides,
  stepValue,
  type SidesField,
  type StyleField,
} from "./inspector-fields.ts";
import { textUnavailable, type LiveEdits } from "./live-edits.ts";

/** A control the inspector reacts to: what typing into it applies, and its arrow-key step. */
interface Binding {
  apply(value: string): void;
  step?: number;
}

function row(label: string, control: Node, extra = ""): HTMLElement {
  return h("div", { class: `field${extra}` }, [
    h("span", { class: "field-label", text: label }),
    control,
  ]);
}
function invalid(node: HTMLInputElement, ok: boolean): void {
  node.classList.toggle("invalid", !ok);
}

/**
 * The style inspector inside the comment editor: the element's tag with a drag handle, then
 * one row per property. Every change previews live through `LiveEdits`; the editor's Save and
 * Cancel decide whether it stays. Typing reaches it through the intercept layer (`ui`), like
 * the comment field, so page listeners never see it.
 */
export function createInspector(edits: LiveEdits, changed: () => void) {
  const tag = h("span", { class: "inspector-tag" });
  const grip = h("div", { class: "handle", attrs: { "aria-label": "Move", title: "Move" } }, [
    icon("grip"),
  ]);
  const body = h("div", { class: "inspector-body" });
  const root = h("div", { class: "inspector", attrs: { role: "group", "aria-label": "Styles" } }, [
    h("div", { class: "inspector-head" }, [tag, grip]),
    body,
  ]);
  const bindings = new Map<Element, Binding>();
  let element: Element | undefined;

  const computed = (property: string) =>
    element ? getComputedStyle(element).getPropertyValue(property).trim() : "";
  const apply = (property: string, value: string) => {
    if (!element) return false;
    const ok = edits.set(element, property, value);
    changed();
    return ok;
  };
  function input(value: string, label: string, binding: Binding): HTMLInputElement {
    const node = h("input", {
      class: "value",
      attrs: { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": label },
    });
    node.value = value;
    bindings.set(node, binding);
    return node;
  }
  function textRow(target: Element): HTMLElement {
    const reason = textUnavailable(target);
    if (reason)
      return row(
        "Text",
        h("span", {
          class: "field-note",
          text: target.childElementCount > 0 ? "Has child elements" : "Not editable",
          attrs: { title: reason },
        }),
        " disabled",
      );
    const node = input(target.textContent ?? "", "Text", {
      apply(value) {
        edits.setText(target, value);
        changed();
      },
    });
    return row("Text", node);
  }
  function colorRow(field: StyleField): HTMLElement {
    const swatch = h("span", { class: "swatch" });
    const picker = h("input", {
      class: "picker",
      attrs: { type: "color", "aria-label": `${field.label} picker`, tabindex: "-1" },
    });
    swatch.append(picker);
    const paint = () => {
      const now = computed(field.property);
      place(swatch, { "--swatch": now || "transparent" });
      picker.value = hexOf(now) ?? "#000000";
    };
    const text = input(computed(field.property), field.label, {
      apply(value) {
        invalid(text, apply(field.property, value));
        paint();
      },
    });
    const pick = () => {
      text.value = picker.value;
      invalid(text, apply(field.property, picker.value));
      paint();
    };
    bindings.set(picker, { apply: pick });
    picker.addEventListener("change", pick);
    paint();
    return row(field.label, h("div", { class: "control color" }, [swatch, text]));
  }
  function selectRow(field: StyleField, choices: string[]): HTMLElement {
    const current = computed(field.property);
    const select = h("select", { class: "value", attrs: { "aria-label": field.label } });
    for (const choice of new Set([current, ...choices])) {
      const option = h("option", { text: choice });
      option.value = choice;
      select.append(option);
    }
    select.value = current;
    const choose = () => void apply(field.property, select.value);
    bindings.set(select, { apply: choose });
    select.addEventListener("change", choose);
    return row(field.label, h("div", { class: "control select" }, [select, icon("chevron")]));
  }
  function valueRow(field: StyleField): HTMLElement {
    const node = input(computed(field.property), field.label, {
      apply: (value) => invalid(node, apply(field.property, value)),
      ...(field.step ? { step: field.step } : {}),
    });
    return row(field.label, node);
  }
  function sidesRow(field: SidesField): HTMLElement {
    const summary = h("span", { class: "field-summary", text: computed(field.property) });
    const toggle = button("disclosure", `Show ${field.label.toLowerCase()} sides`, [], () => {
      const open = !group.hidden;
      group.hidden = open;
      toggle.classList.toggle("open", !open);
      toggle.setAttribute("aria-expanded", String(!open));
    });
    toggle.setAttribute("aria-expanded", "false");
    toggle.append(icon("chevron"), h("span", { text: field.label }));
    const group = h("div", { class: "sides" });
    group.hidden = true;
    for (const side of sides) {
      const property = `${field.property}-${side}`;
      const label = `${side[0]?.toUpperCase() ?? ""}${side.slice(1)}`;
      const node = input(computed(property), `${field.label} ${side}`, {
        apply(value) {
          invalid(node, apply(property, value));
          summary.textContent = computed(field.property);
        },
        step: 1,
      });
      group.append(row(label, node, " side"));
    }
    return h("div", { class: "field-group" }, [
      h("div", { class: "field" }, [toggle, summary]),
      group,
    ]);
  }

  function build(target: Element): void {
    bindings.clear();
    const rows: Node[] = [textRow(target)];
    for (const field of inspectorFields) {
      if (field.kind === "sides") rows.push(sidesRow(field));
      else if (field.kind === "color") rows.push(colorRow(field));
      else if (field.kind === "font")
        rows.push(selectRow(field, fontChoices(computed(field.property))));
      else if (field.kind === "weight") rows.push(selectRow(field, fontWeights));
      else rows.push(valueRow(field));
    }
    body.replaceChildren(...rows);
    body.scrollTop = 0;
  }

  return {
    root,
    grip,
    /** Show `target`'s current values. */
    show(target: Element): void {
      element = target;
      tag.textContent = `<${target.localName}>`;
      build(target);
    },
    /** Typing in the focused control; true when the inspector handled the event. */
    ui(event: Event, focused: Element | null): boolean {
      const binding = focused ? bindings.get(focused) : undefined;
      if (
        !binding ||
        !(focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement)
      )
        return false;
      if (event.type === "input") {
        binding.apply(focused.value);
        return true;
      }
      if (!(event instanceof KeyboardEvent) || event.type !== "keydown" || event.isComposing)
        return false;
      const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      if (!direction || !binding.step || !(focused instanceof HTMLInputElement)) return false;
      const next = stepValue(focused.value, direction * binding.step * (event.shiftKey ? 10 : 1));
      if (next === undefined) return false;
      event.preventDefault();
      focused.value = next;
      binding.apply(next);
      return true;
    },
    contains(node: Node): boolean {
      return root.contains(node);
    },
  };
}
export type Inspector = ReturnType<typeof createInspector>;
