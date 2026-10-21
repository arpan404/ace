import { FileIcon, GitDiffIcon } from "@phosphor-icons/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LayoutProvider } from "@/lib/layout.tsx";
import {
  defineTabKind,
  defineWorkspace,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { TabStrip } from "./tab-strip.tsx";

/*
 * jsdom has no layout, so text is 7px a character and the strip has 600px: enough for the
 * strip's layout pass to size tabs from what they show.
 */
const charWidth = 7;
const patched = ["scrollWidth", "clientWidth", "offsetWidth", "scrollBy"] as const;
const originals = patched.map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const measured = this.hasAttribute("data-tab-title") || this.hasAttribute("data-tab-badge");
      return measured ? (this.textContent?.length ?? 0) * charWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 28,
  });
});
afterEach(() => {
  for (const [name, descriptor] of originals)
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

/** A live diff stat that arrives after the tab first drew, like the Changes badge. */
let stat = "";
const statListeners = new Set<() => void>();
const setStat = (next: string) => {
  stat = next;
  for (const listener of statListeners) listener();
};
function DiffBadge() {
  const value = useSyncExternalStore(
    (listener) => {
      statListeners.add(listener);
      return () => statListeners.delete(listener);
    },
    () => stat,
  );
  return value ? <span>{value}</span> : null;
}

const changes = defineTabKind({
  kind: "changes",
  label: "Changes",
  icon: GitDiffIcon,
  singleton: true,
  pinned: true,
  Badge: DiffBadge,
  load: () => Promise.resolve({ default: () => null }),
});
const file = defineTabKind({
  kind: "file",
  label: "File",
  icon: FileIcon,
  load: () => Promise.resolve({ default: () => null }),
});

function Strip(props: { definition: WorkspaceDefinition }) {
  const store = useWorkspaceStore();
  store.define("scope", props.definition);
  const workspace = useScopeWorkspace("scope");
  const actions = useWorkspaceActions("scope");
  return (
    <TabStrip
      scope="scope"
      label="Tabs"
      state={workspace}
      definition={props.definition}
      actions={actions}
    />
  );
}

/** The tab's own box, which the strip sizes. */
function tabBox(name: string): HTMLElement {
  const box = screen
    .getByRole("tab", { name: new RegExp(`^${name}`) })
    .closest<HTMLElement>("[data-tab-key]");
  if (!box) throw new Error(`No tab box for ${name}`);
  return box;
}

test("a live badge updates without changing the fixed tab width", async () => {
  stat = "";
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [{ kind: "changes" }, { kind: "file", id: "a", title: "notes.md" }],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  const before = parseFloat(tabBox("Changes").style.width);
  expect(before).toBeGreaterThan(0);

  // The badge has its own subscription: the strip itself doesn't re-render.
  await act(async () => setStat("+17 −5"));
  const after = parseFloat(tabBox("Changes").style.width);
  expect(after).toBe(before);
  expect(screen.getByRole("tab", { name: /^Changes/ }).textContent).toContain("+17 −5");
});

test("while a tool's code loads, its tab shows the tool's shape rather than a spinner", async () => {
  const { TabContent } = await import("./tab-content.tsx");
  const slow = defineTabKind({
    kind: "files",
    label: "Files",
    icon: FileIcon,
    // A tool's own shape (the Files tree, say), not the generic spinner.
    Skeleton: () => <div role="status" aria-label="Loading Files" />,
    load: () => new Promise(() => {}),
  });
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "files",
    initial: [{ kind: "files", id: "a" }],
    kinds: () => Promise.resolve({ default: [slow] }),
  });
  await definition.load();
  const tab = { key: "files:a", kind: "files", id: "a", pinned: false };
  render(
    <TabContent
      scope="scope"
      definition={definition}
      tabs={[tab]}
      shown={tab.key}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByRole("status", { name: "Loading Files" })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
});

const names = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

test("Alt+Shift+arrows move the focused tab, and the strip says where it went", async () => {
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [
      { kind: "file", id: "a", title: "notes.md" },
      { kind: "file", id: "b", title: "todo.md" },
      { kind: "file", id: "c", title: "plan.md" },
    ],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  screen.getByRole("tab", { name: /notes\.md/ }).focus();
  await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
  expect(names()).toEqual(["todo.md", "notes.md", "plan.md"]);
  expect(screen.getByText("notes.md moved to position 2 of 3")).toBeTruthy();
  // Focus stays with the moved tab, so it can go on moving.
  await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
  expect(names()).toEqual(["todo.md", "plan.md", "notes.md"]);
});

test("the overflowing side panel menu opens and switches the selected tab", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "tablist"
        ? 900
        : (this.textContent?.length ?? 0) * charWidth;
    },
  });
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [{ kind: "changes" }, { kind: "file", id: "a", title: "app.tsx" }],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: "All tabs" }));
  expect(await screen.findByText("Open tabs")).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "app.tsx" }));
  expect(screen.getByRole("tab", { name: "app.tsx", selected: true })).toBeTruthy();
});

test("a vertical wheel over an overflowing strip scrolls its tabs sideways", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "tablist"
        ? 900
        : (this.textContent?.length ?? 0) * charWidth;
    },
  });
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [
      { kind: "file", id: "a", title: "notes.md" },
      { kind: "file", id: "b", title: "todo.md" },
    ],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  const strip = screen.getByRole("tablist", { name: "Tabs" });
  strip.scrollLeft = 0;
  // fireEvent returns false when the strip took the wheel for itself.
  expect(fireEvent.wheel(strip, { deltaY: 120 })).toBe(false);
  expect(strip.scrollLeft).toBe(120);
  // At the far end the wheel goes on to the page.
  strip.scrollLeft = 300;
  expect(fireEvent.wheel(strip, { deltaY: 120 })).toBe(true);
  expect(strip.scrollLeft).toBe(300);
});

test("a scrolled strip stays where it was scrolled while the pointer moves over its tabs", async () => {
  // Like a browser, scrollBy moves the strip.
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollLeft += options.left ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "tablist"
        ? 900
        : (this.textContent?.length ?? 0) * charWidth;
    },
  });
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [
      { kind: "file", id: "a", title: "notes.md" },
      { kind: "file", id: "b", title: "todo.md" },
    ],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  const strip = screen.getByRole("tablist", { name: "Tabs" });
  strip.scrollLeft = 0;
  fireEvent.wheel(strip, { deltaY: 120 });
  act(() => {
    fireEvent.scroll(strip);
  });
  expect(strip.scrollLeft).toBe(120);
  // A hover fade on a tab ends while the strip is scrolled away from the showing tab.
  act(() => {
    fireEvent.transitionEnd(tabBox("todo.md"));
  });
  expect(strip.scrollLeft).toBe(120);
});

/** A drag's data, as jsdom has no DataTransfer. */
function dragData() {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
}

/** A drag event at `clientX` (jsdom has no DragEvent, so a mouse event carries the point). */
function drag(type: string, target: Element, data: ReturnType<typeof dragData>, clientX = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, "dataTransfer", { value: data });
  fireEvent(target, event);
}

/** A layout box, for the fake layout below. */
const rect = (left: number, width: number) =>
  ({
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 28,
    height: 28,
    x: left,
    y: 0,
  }) as DOMRect;

/** Three 120px tabs from x 10, in a strip from x 0 to 300 that scrolls (jsdom has no layout). */
async function laidOutStrip() {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const boxes = [...(this.parentElement?.querySelectorAll(":scope > [data-tab-key]") ?? [])];
      const at = boxes.indexOf(this);
      if (at >= 0) return rect(10 + at * 120, 120);
      return this.getAttribute("role") === "tablist" ? rect(0, 300) : rect(0, 0);
    },
  });
  afterEach(() => {
    if (original) Object.defineProperty(Element.prototype, "getBoundingClientRect", original);
  });
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "tablist"
        ? 900
        : (this.textContent?.length ?? 0) * charWidth;
    },
  });
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [
      { kind: "file", id: "a", title: "notes.md" },
      { kind: "file", id: "b", title: "todo.md" },
      { kind: "file", id: "c", title: "plan.md" },
    ],
    kinds: () => Promise.resolve({ default: [changes, file] }),
  });
  await definition.load();
  render(
    <LayoutProvider>
      <Strip definition={definition} />
    </LayoutProvider>,
  );
  return screen.getByRole("tablist", { name: "Tabs" });
}

test("a tab dropped at the strip's far left goes first, not last", async () => {
  const strip = await laidOutStrip();
  const data = dragData();
  drag("dragstart", tabBox("plan.md"), data);
  // Over the strip's own padding, left of the first tab.
  drag("dragover", strip, data, 4);
  drag("drop", strip, data, 4);
  expect(names()).toEqual(["plan.md", "notes.md", "todo.md"]);
});

test("holding a dragged tab at the strip's edge scrolls the strip toward it", async () => {
  const strip = await laidOutStrip();
  const data = dragData();
  drag("dragstart", tabBox("notes.md"), data);
  strip.scrollLeft = 100;
  drag("dragover", strip, data, 150);
  expect(strip.scrollLeft).toBe(100);
  drag("dragover", strip, data, 296);
  const right = strip.scrollLeft;
  expect(right).toBeGreaterThan(100);
  // Dragover repeats while the pointer holds still, so the strip keeps going.
  drag("dragover", strip, data, 296);
  const further = strip.scrollLeft;
  expect(further).toBeGreaterThan(right);
  drag("dragover", strip, data, 3);
  expect(strip.scrollLeft).toBeLessThan(further);
});

test("a trackpad's sideways swipe keeps its vertical drift from moving the strip", async () => {
  const strip = await laidOutStrip();
  strip.scrollLeft = 50;
  fireEvent.wheel(strip, { deltaX: 30, deltaY: 0 });
  // Drift within the same swipe: left to the browser, not turned into sideways movement.
  expect(fireEvent.wheel(strip, { deltaX: 0, deltaY: 4 })).toBe(true);
  expect(strip.scrollLeft).toBe(50);
});
