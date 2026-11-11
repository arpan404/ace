import "./test-host.ts";
import { expect, test } from "vitest";
import { BrowserState } from "@ace/protocol";
import { BrowserPageTools } from "./browser-page-tools.ts";
import { plainPreview, RecordingSink, until } from "./sheet-fixture.ts";

for (const kind of ["source", "extensions"] as const) {
  test(`a failed ${kind} read reports a problem rather than empty content`, async () => {
    const sink = new RecordingSink();
    const state = BrowserState.parse({
      threadId: "web",
      url: "https://example.test",
      closed: false,
      activeTabId: "tab",
    });
    const page = new BrowserPageTools({
      owner: {
        request: async () => {
          throw new Error("Disconnected");
        },
      },
      sink,
      preview: plainPreview,
      now: () => 1000,
      current: () => ({ threadId: state.threadId, state }),
      files: { write: async () => undefined, discard: async () => undefined },
    });
    page.handle(kind === "source" ? { kind, open: true } : { kind });
    await until(() => sink.read("browser:problem") !== undefined, "failure");
    expect(sink.read("browser:problem")?.message).toContain("Disconnected");
    if (kind === "extensions") expect(sink.read("browser:extensions")?.items).toBeNull();
    else expect(sink.read("browser:source")).toBeUndefined();
    page.close();
  });
}
