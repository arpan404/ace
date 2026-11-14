import { afterEach, describe, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

afterEach(closeBrowserFixtures);

type Engine =
  | { current: string | null; moving: boolean; note: string; choices: unknown[] }
  | null
  | undefined;
const engine = (sink: RecordingSink) => sink.read("browser:view")?.engine as Engine;
const url = (sink: RecordingSink) =>
  (sink.read("browser:view")?.state as { url?: string } | null | undefined)?.url;

describe("Engine for this thread", () => {
  test("the menu checks the engine the thread's browser runs on and names the default", async () => {
    const { daemon, sink, view } = await live();
    daemon.browser.drive("web", { url: "https://shop.test/cart", backend: "embedded" });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => engine(sink)?.current === "embedded", "engine");
    await until(() => engine(sink)?.note.includes("App, then ace's Chrome") === true, "default");
    expect(engine(sink)).toEqual({
      current: "embedded",
      moving: false,
      note: "Other threads use App, then ace's Chrome, the default in Settings › Browser.",
      choices: [
        { value: "embedded", label: "Desktop app only" },
        { value: "headless", label: "ace's Chrome only" },
      ],
    });
  });

  test("switching moves the open browser to ace's Chrome with its page loaded again", async () => {
    const { daemon, sink, view, requested } = await live();
    daemon.browser.drive("web", { url: "https://shop.test/cart", backend: "embedded" });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => engine(sink)?.current === "embedded", "engine");
    expect(view.action({ kind: "engine", engine: "headless" })).toBe(true);
    await until(() => daemon.browser.view("web")?.backend === "headless", "moved");
    await until(() => engine(sink)?.current === "headless" && !engine(sink)?.moving, "shown");
    await until(() => url(sink) === "https://shop.test/cart", "page reloaded");
    expect(requested).toContainEqual(
      expect.objectContaining({
        type: "settings.set",
        key: "browser.backend",
        value: "headless",
        layer: { kind: "thread", threadId: "web" },
      }),
    );
  });

  test("Desktop app only on a machine without the desktop app is refused and the page stays", async () => {
    const { daemon, sink, view, requested } = await live();
    daemon.browser.desktop = false;
    daemon.browser.drive("web", { url: "https://shop.test/cart", backend: "headless" });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => engine(sink)?.current === "headless", "engine");
    view.action({ kind: "engine", engine: "embedded" });
    await until(() => sink.read("browser:problem") !== undefined, "problem");
    expect(sink.read("browser:problem")).toMatchObject({
      message: expect.stringMatching(
        /^Couldn't switch the browser engine\. The desktop app isn't running/,
      ),
    });
    expect(requested).not.toContainEqual(expect.objectContaining({ type: "browser.close" }));
    expect(daemon.browser.view("web")).toMatchObject({ backend: "headless", closed: false });
    await until(() => !engine(sink)?.moving, "settled");
    expect(engine(sink)?.current).toBe("headless");
    expect(url(sink)).toBe("https://shop.test/cart");
  });
});
