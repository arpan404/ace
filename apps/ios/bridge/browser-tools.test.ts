import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { addressProblems } from "@ace/ui-core";
import { closeBrowserFixtures, liveBrowser, viewport } from "./browser-fixture.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

/*
 * What the person does with the thread's browser from the phone, over a real client and the
 * fake daemon: addresses, tabs, who controls the page, the answers a page waits for, the
 * console, zoom and history.
 */

afterEach(closeBrowserFixtures);

interface ShownState {
  url: string;
  address: string;
  blank: boolean;
  activeTabId: string | null;
  tabs: { id: string; title: string; host: string; agent: string | null; private: boolean }[];
  shown: { agent: string | null; private: boolean; zoom: string | null; pointer: unknown } | null;
  failure: { title: string; detail: string; host: string } | null;
  certificate: { title: string; url: string } | null;
  dialog: { dialogId: string; tabId: string; type: string; message: string; site: string } | null;
  auth: { authId: string; tabId: string; site: string; realm: string | null } | null;
  chooser: { chooserId: string; tabId: string; multiple: boolean } | null;
  downloads: { filename: string; state: string; risky: boolean }[];
  disconnected: boolean;
}
const state = (sink: RecordingSink) =>
  sink.read("browser:view")?.state as ShownState | null | undefined;
const problem = (sink: RecordingSink) =>
  sink.read("browser:problem")?.message as string | undefined;

async function opened(options: Parameters<typeof liveBrowser>[0] = {}) {
  const fixture = await liveBrowser(options);
  fixture.view.action({ kind: "open", threadId: "web", viewport });
  if (options.browser !== false)
    await until(() => state(fixture.sink)?.activeTabId != null, "browser state");
  const tabId = () => state(fixture.sink)?.activeTabId ?? "";
  return { ...fixture, tabId };
}

describe("The phone's browser tools", () => {
  test("an agent using the shown page is named; Take over keeps agents out until Hand back", async () => {
    const { daemon, sink, view, tabId } = await opened({ names: { reviewer: "Reviewer" } });
    daemon.browser.agentWorks("web", { agentId: "reviewer", pointer: { x: 40, y: 80 } });
    await until(() => state(sink)?.shown?.agent === "Reviewer", "agent named");
    expect(state(sink)?.shown?.pointer).toMatchObject({ x: 40, y: 80 });
    expect(state(sink)?.tabs[0]).toMatchObject({ agent: "Reviewer", private: false });

    view.action({ kind: "private", tabId: tabId(), value: true });
    await until(() => state(sink)?.shown?.private === true, "taken over");
    expect(state(sink)?.shown).toMatchObject({ agent: null, pointer: null });
    expect(() => daemon.browser.agentWorks("web", { agentId: "reviewer" })).toThrow();

    view.action({ kind: "private", tabId: tabId(), value: false });
    await until(() => state(sink)?.shown?.private === false, "handed back");
    daemon.browser.agentWorks("web", { agentId: "reviewer" });
    await until(() => state(sink)?.shown?.agent === "Reviewer", "agent back");
  });

  test("an address goes to the shown tab; text that isn't one is refused in words", async () => {
    const { daemon, sink, view } = await opened();
    view.action({ kind: "go", text: "shop.test/pay" });
    // The bar shows the address at once, while the page loads.
    expect(state(sink)?.address).toBe("shop.test/pay");
    await until(() => daemon.browser.tab("web")?.url === "https://shop.test/pay", "navigated");
    view.action({ kind: "go", text: "pay for the cart" });
    await until(() => problem(sink) !== undefined, "refused");
    expect(problem(sink)).toBe(addressProblems.not_address);
  });

  test("a thread without a browser opens one for its first address, in the blank tab", async () => {
    const { daemon, sink, view } = await opened({ browser: false });
    await until(() => sink.read("browser:view")?.error != null, "no browser yet");
    view.action({ kind: "go", text: "example.com" });
    await until(() => state(sink)?.address === "example.com", "opened and navigated");
    expect(state(sink)?.tabs).toHaveLength(1);
    expect(daemon.browser.tab("web")?.url).toBe("https://example.com/");
  });

  test("a failed load shows in place of the page; Back returns to the page the tab still shows", async () => {
    const { sink, view } = await opened();
    view.action({ kind: "go", text: "https://missing.invalid/" });
    await until(() => state(sink)?.failure != null, "failure");
    expect(state(sink)?.failure).toMatchObject({
      title: "This site can't be reached",
      host: "missing.invalid",
    });
    expect(state(sink)?.address).toBe("missing.invalid");
    view.action({ kind: "history", direction: "back" });
    await until(() => state(sink)?.failure === null, "dismissed");
    expect(state(sink)?.address).toBe("shop.test/cart");
  });

  test("new tabs open shown, and closing one leaves the others", async () => {
    const { sink, view, tabId } = await opened();
    const first = tabId();
    view.action({ kind: "newTab", text: "shop.test/help" });
    await until(() => state(sink)?.tabs.length === 2, "second tab");
    await until(() => state(sink)?.activeTabId !== first, "shown at once");
    view.action({ kind: "closeTab", tabId: tabId() });
    await until(() => state(sink)?.tabs.length === 1, "closed");
    expect(state(sink)?.tabs[0]?.id).toBe(first);
  });

  test("a page's dialog, sign-in and file picker name their site, and the answers reach the page", async () => {
    const { daemon, sink, view, tabId } = await opened();
    daemon.browser.dialogOpen("web", {
      dialogId: "d1",
      tabId: tabId(),
      type: "confirm",
      message: "Remove the item?",
    });
    await until(() => state(sink)?.dialog != null, "dialog");
    expect(state(sink)?.dialog).toMatchObject({
      type: "confirm",
      message: "Remove the item?",
      site: "shop.test",
    });
    view.action({ kind: "dialog", tabId: tabId(), dialogId: "d1", accept: true });
    await until(() => state(sink)?.dialog === null, "answered");

    const authId = daemon.browser.signInAsk("web", tabId(), "Staff only");
    await until(() => state(sink)?.auth != null, "sign-in");
    expect(state(sink)?.auth).toMatchObject({ authId, site: "shop.test", realm: "Staff only" });
    view.action({
      kind: "signIn",
      tabId: tabId(),
      authId,
      credentials: { username: "ada", password: "pw" },
    });
    await until(() => state(sink)?.auth === null, "signed in");
    expect(daemon.browser.signIns).toEqual([{ username: "ada", password: "pw" }]);

    const chooserId = daemon.browser.fileChooserOpen("web", tabId(), false);
    await until(() => state(sink)?.chooser != null, "file picker");
    view.action({ kind: "files", tabId: tabId(), chooserId, files: [] });
    await until(() => state(sink)?.chooser === null, "cancelled");
    expect(daemon.browser.chosenFiles).toEqual([[]]);
  });

  test("files picked for the page upload first, then reach its input by hash", async () => {
    const bytes = new TextEncoder().encode("name,total\nada,12\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { daemon, sink, view, tabId } = await opened({
      read: async (_id, offset, limit) =>
        Buffer.from(bytes.slice(offset, offset + limit)).toString("base64"),
    });
    const chooserId = daemon.browser.fileChooserOpen("web", tabId(), true);
    await until(() => state(sink)?.chooser != null, "file picker");
    view.action({
      kind: "files",
      tabId: tabId(),
      chooserId,
      files: [
        {
          localId: "picked-0001",
          name: "orders.csv",
          mimeType: "text/csv",
          bytes: bytes.length,
          sha256,
        },
      ],
    });
    await until(() => daemon.browser.chosenFiles.length === 1, "chosen");
    expect(daemon.browser.chosenFiles[0]).toEqual([{ sha256, name: "orders.csv" }]);
  });

  test("an untrusted certificate says so, and proceeding opens the page", async () => {
    const { daemon, sink, view, tabId } = await opened();
    daemon.browser.certificateFail(
      "web",
      tabId(),
      "https://shop.test/admin",
      "ERR_CERT_AUTHORITY_INVALID",
    );
    await until(() => state(sink)?.certificate != null, "certificate");
    expect(state(sink)?.certificate).toMatchObject({ title: "This connection isn't private" });
    view.action({ kind: "certificate", tabId: tabId(), url: "https://shop.test/admin" });
    await until(() => state(sink)?.certificate === null, "proceeded");
  });

  test("the console lists the tab's messages by level, and Clear hides what was listed", async () => {
    const { daemon, sink, view, tabId, scheduled } = await opened();
    const log = (type: string, text: string) =>
      daemon.browser.logs.add("web", { kind: "console", type, text, tabId: tabId() });
    log("error", "Checkout failed");
    log("warning", "Slow image");
    log("log", "Cart loaded");
    const texts = () =>
      (sink.read("browser:logs")?.entries as { text: string }[] | undefined)?.map(
        (entry) => entry.text,
      );
    const filter = { section: "console", level: "all", requests: "all" } as const;
    view.action({ kind: "console", filter, clear: false });
    await until(() => texts()?.length === 3, "all levels");
    view.action({ kind: "console", filter: { ...filter, level: "error" }, clear: false });
    await until(() => texts()?.length === 1, "errors only");
    expect(texts()).toEqual(["Checkout failed"]);
    view.action({ kind: "console", filter: { ...filter, level: "error" }, clear: true });
    await until(() => texts()?.length === 0, "cleared");
    log("error", "Payment refused");
    scheduled.splice(0).forEach((tick) => tick());
    await until(() => texts()?.length === 1, "new message");
    expect(texts()).toEqual(["Payment refused"]);
    view.action({ kind: "console", clear: false });
    expect(sink.read("browser:logs")).toBeUndefined();
  });

  test("zoom steps up from 100% and resets", async () => {
    const { sink, view } = await opened();
    view.action({ kind: "zoom", step: "in" });
    await until(() => state(sink)?.shown?.zoom === "110%", "zoomed in");
    view.action({ kind: "zoom", step: "reset" });
    await until(() => state(sink)?.shown?.zoom === null, "reset");
  });

  test("history lists the pages shown newest first, and a visit can be forgotten", async () => {
    const { sink, view } = await opened();
    view.action({ kind: "go", text: "shop.test/pay" });
    await until(() => state(sink)?.address === "shop.test/pay", "navigated");
    view.action({ kind: "visits", open: true });
    const visits = () =>
      sink.read("browser:visits")?.visits as { url: string; at: number }[] | undefined;
    await until(() => visits()?.length === 2, "visits");
    expect(visits()?.map((visit) => visit.url)).toEqual([
      "https://shop.test/pay",
      "https://shop.test/cart",
    ]);
    view.action({ kind: "visits", open: true, query: "PAY" });
    await until(() => visits()?.length === 1, "searched");
    expect(sink.read("browser:visits")?.total).toBe(2);
    view.action({ kind: "visits", open: true });
    await until(() => visits()?.length === 2, "search cleared");
    const newest = visits()?.[0];
    if (newest) view.action({ kind: "forget", url: newest.url, at: newest.at });
    await until(() => visits()?.length === 1, "forgotten");
  });

  test("downloads list what the thread's tabs fetched, executables marked", async () => {
    const { daemon, sink, tabId } = await opened();
    daemon.browser.downloadAdd("web", {
      downloadId: "d1",
      tabId: tabId(),
      filename: "setup.exe",
      bytes: 2048,
      mimeType: "application/octet-stream",
      flags: ["executable"],
      state: "complete",
      path: "/fixture/setup.exe",
    });
    await until(() => state(sink)?.downloads.length === 1, "download");
    expect(state(sink)?.downloads[0]).toMatchObject({
      filename: "setup.exe",
      state: "Downloaded",
      risky: true,
    });
  });

  test("a browser that lost its pages offers Reopen, which brings them back", async () => {
    const { daemon, sink, view } = await opened();
    daemon.browser.lose("web");
    await until(() => state(sink)?.disconnected === true, "disconnected");
    view.action({ kind: "reopen" });
    await until(() => state(sink)?.disconnected === false, "reopened");
  });
});
