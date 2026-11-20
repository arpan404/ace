import { FileIcon } from "@ace/icons";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  defineTabKind,
  defineWorkspace,
  type TabModule,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { TabContent } from "./tab-content.tsx";

/*
 * A tool's tab while its code loads: the kind's skeleton, then its view the moment the chunk
 * lands; a tool already loaded draws at once; a failed load says so in the tab and tries again.
 */

const tab: WorkspaceTab = { key: "editor", kind: "editor", id: "editor", pinned: false };

async function workspaceWith(load: () => Promise<TabModule>) {
  const kind = defineTabKind({
    kind: "editor",
    label: "Editor",
    icon: FileIcon,
    singleton: true,
    load,
    Skeleton: () => <p>Editor skeleton</p>,
  });
  const definition = defineWorkspace({
    label: "Thread panel",
    launcher: "new-tab",
    initial: [],
    kinds: async () => ({ default: [kind] }),
  });
  await definition.load();
  return { definition, kind };
}

const view: TabModule = { default: () => <p>Editor view</p> };

function show(definition: Awaited<ReturnType<typeof workspaceWith>>["definition"]) {
  return render(
    <TabContent
      scope="t1"
      definition={definition}
      tabs={[tab]}
      shown="editor"
      onClose={() => {}}
    />,
  );
}

test("a tool whose code is loading shows its skeleton, then its view as soon as it lands", async () => {
  const code = Promise.withResolvers<TabModule>();
  const { definition } = await workspaceWith(() => code.promise);
  show(definition);
  expect(screen.getByText("Editor skeleton")).toBeTruthy();
  await act(async () => code.resolve(view));
  expect(screen.getByText("Editor view")).toBeTruthy();
  expect(screen.queryByText("Editor skeleton")).toBeNull();
});

test("a tool whose code already loaded draws its view in the first render", async () => {
  const { definition, kind } = await workspaceWith(async () => view);
  await kind.load();
  show(definition);
  expect(screen.getByText("Editor view")).toBeTruthy();
});

test("a tool whose code fails to load says so in its tab, and Try again loads it", async () => {
  const load = vi
    .fn<() => Promise<TabModule>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(view);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { definition } = await workspaceWith(load);
  show(definition);
  expect((await screen.findByRole("alert")).textContent).toContain("Editor couldn't load");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Editor view")).toBeTruthy();
});
