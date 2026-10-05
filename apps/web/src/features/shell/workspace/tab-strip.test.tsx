import { FileIcon, GitDiffIcon } from "@phosphor-icons/react";
import { act, render, screen } from "@testing-library/react";
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
const patched = ["scrollWidth", "clientWidth", "offsetWidth"] as const;
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
      dock="right"
      label="Tabs"
      state={workspace.right}
      definition={props.definition}
      actions={actions}
    />
  );
}

const tabBox = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) }).closest<HTMLElement>("[data-tab-key]")!;

test("the showing tab grows to fit its badge when the badge arrives after the tab drew", async () => {
  stat = "";
  const definition = defineWorkspace({
    label: "Side panel",
    docks: ["right"],
    launcher: "file",
    initial: [
      { kind: "changes", dock: "right" },
      { kind: "file", id: "a", title: "notes.md", dock: "right" },
    ],
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
  // The whole badge (6 characters) and its gap fit beside the whole title.
  expect(after).toBeGreaterThanOrEqual(before + 6 * charWidth);
});
