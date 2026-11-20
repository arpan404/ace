import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

/*
 * A Deck tab's "Open in" menu: the daemon machine's editors, terminals and file manager,
 * grouped, opening the file on that machine.
 */

const file = "apps/web/src/relay/socket.ts";

async function openFile() {
  const app = harness();
  folderFixture(app.client, "thread-cold-start");
  app.daemon.workspace.setEditors([
    { id: "zed", name: "Zed", command: "zed" },
    { id: "xcode", name: "Xcode", command: "/Applications/Xcode.app" },
  ]);
  app.daemon.workspace.setTerminals([
    { id: "ghostty", name: "Ghostty", command: "/Applications/Ghostty.app" },
  ]);
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "socket");
  await userEvent.keyboard("{Enter}");
  const side = await screen.findByRole("region", { name: "Thread panel" });
  const tab = await within(side).findByRole("tab", { name: "socket.ts", selected: true });
  /** The tab's menu, then its Open in submenu. */
  const menu = async () => {
    await userEvent.keyboard("{Escape}");
    await userEvent.pointer({ target: tab, keys: "[MouseRight]" });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open in" }));
    await waitFor(() => expect(screen.getAllByRole("menu").length).toBeGreaterThan(1));
    return screen.getAllByRole("menu").at(-1) ?? screen.getByRole("menu");
  };
  /** The editor the menu marks as the default. */
  const preferred = async () =>
    within(await menu())
      .getAllByRole("menuitem")
      .find((item) => item.textContent?.endsWith("default"))
      ?.textContent?.replace(/default$/, "");
  return { app, side, menu, preferred };
}

test("the menu lists editors, then terminals, then the file manager, with the default marked", async () => {
  const { menu } = await openFile();
  const list = await menu();
  const groups = within(list).getAllByRole("group");
  expect(
    groups.map((group) =>
      within(group)
        .queryAllByRole("menuitem")
        .map((item) => item.textContent),
    ),
  ).toEqual([["Zeddefault", "Xcode"], ["Ghostty"], ["Reveal in Finder"]]);
});

test("a terminal opens the file's place on the daemon's machine and doesn't become the default", async () => {
  const { app, menu, preferred } = await openFile();
  await userEvent.click(within(await menu()).getByRole("menuitem", { name: "Ghostty" }));
  await waitFor(() =>
    expect(app.daemon.workspace.opened).toEqual([
      { app: "ghostty", folder: "thread-cold-start", path: file },
    ]),
  );
  expect(await preferred()).toBe("Zed");
});

test("Reveal in Finder shows the file in the daemon machine's file manager", async () => {
  const { app, menu } = await openFile();
  await userEvent.click(within(await menu()).getByRole("menuitem", { name: "Reveal in Finder" }));
  await waitFor(() =>
    expect(app.daemon.workspace.opened).toEqual([
      { app: "files", folder: "thread-cold-start", path: file },
    ]),
  );
});

test("an editor this device can't open itself opens on the daemon's machine and becomes the default", async () => {
  const { app, menu, preferred } = await openFile();
  await userEvent.click(within(await menu()).getByRole("menuitem", { name: "Xcode" }));
  await waitFor(() =>
    expect(app.daemon.workspace.opened).toEqual([
      { app: "xcode", folder: "thread-cold-start", path: file },
    ]),
  );
  await waitFor(async () => expect(await preferred()).toBe("Xcode"));
});

test("in the desktop app a terminal shows its own app icon, read from its bundle", async () => {
  const icon = "data:image/png;base64,R0hPU1RUWQ==";
  const asked: string[] = [];
  Reflect.set(window, "ace", {
    shell: {
      appIcon: async (path: string) => {
        asked.push(path);
        return path === "/Applications/Ghostty.app" ? icon : null;
      },
    },
  });
  try {
    const { menu } = await openFile();
    const row = within(await menu()).getByRole("menuitem", { name: "Ghostty" });
    await waitFor(() =>
      expect(row.querySelector('[data-app-icon="ghostty"]')?.getAttribute("src")).toBe(icon),
    );
    expect(asked).toContain("/Applications/Ghostty.app");
  } finally {
    Reflect.deleteProperty(window, "ace");
  }
});
