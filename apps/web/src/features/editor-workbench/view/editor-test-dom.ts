import { screen, within } from "@testing-library/react";
import type { Start } from "./editor-test-support.tsx";
import { group, tab } from "./editor-test-support.tsx";

/** Queries and drag data for driving the editor in jsdom. */

/** jsdom has no DragEvent; a MouseEvent carries the pointer position the drop needs. */
export function allowDragEvents(): void {
  if (!("DragEvent" in window)) Object.assign(window, { DragEvent: MouseEvent });
}

export function transfer(): DataTransfer {
  const data = new Map<string, string>();
  const fake = {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  };
  return fake as Partial<DataTransfer> as DataTransfer;
}

export function region(number: number): HTMLElement {
  return screen.getByRole("region", { name: `Group ${number}` });
}

export function strip(number: number): HTMLElement {
  return within(region(number)).getByRole("tablist");
}

export function tabNames(number: number): (string | null)[] {
  return within(strip(number))
    .getAllByRole("tab")
    .map((each) => each.textContent);
}

export function editorArea(number: number): HTMLElement {
  const area = region(number).querySelector<HTMLElement>('[data-part="buffer-editor"]');
  if (!area) throw new Error("no editor area");
  return area;
}

export const one = (tabs = [tab("src/a.ts"), tab("src/b.ts")]): Start => ({
  root: group("g0", tabs),
  focused: "g0",
});

export const two = (left = [tab("a.ts")], right = [tab("c.ts")], focused = "g0"): Start => ({
  root: {
    kind: "split",
    direction: "row",
    sizes: [0.5, 0.5],
    children: [group("g0", left), group("g9", right)],
  },
  focused,
});
