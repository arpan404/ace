import { expect, test } from "vitest";
import { BrowserConsole } from "./browser-console.ts";
import { plainPreview, RecordingSink } from "./sheet-fixture.ts";

test("a failed console read is visible and a retry can distinguish an empty log", async () => {
  const sink = new RecordingSink();
  let fail = true;
  const console = new BrowserConsole(
    {
      sink,
      preview: plainPreview,
      schedule: () => () => {},
      current: () => ({ state: { activeTabId: "tab" } }),
    },
    async () => {
      if (fail) throw new Error("Disconnected");
      return { entries: [] };
    },
  );
  const filter = { section: "console", level: "all", requests: "all" } as const;
  console.open(filter, false, "tab");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sink.read("browser:logs")?.message).toBe("Disconnected");
  expect(sink.read("browser:logs")?.state).toBe("error");
  fail = false;
  console.open(filter, false, "tab");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sink.read("browser:logs")?.state).toBe("ready");
  expect(sink.read("browser:logs")?.entries).toEqual([]);
  console.close();
});
