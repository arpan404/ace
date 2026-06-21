import { describe, expect, it } from "vitest";

import { resolveBrowserInstanceScopeId, resolveBrowserThreadIdFromScopeId } from "./scope";

describe("browser scope", () => {
  it("keeps browser scope stable for legacy callers without a window instance", () => {
    expect(resolveBrowserInstanceScopeId({ threadId: "thread-1", placement: "right" })).toBe(
      "thread-1:browser:right",
    );
  });

  it("isolates the same thread and placement across app windows", () => {
    const firstScope = resolveBrowserInstanceScopeId({
      threadId: "thread-1",
      placement: "right",
      windowInstanceId: "window-a",
    });
    const secondScope = resolveBrowserInstanceScopeId({
      threadId: "thread-1",
      placement: "right",
      windowInstanceId: "window-b",
    });

    expect(firstScope).toBe("thread-1:browser:right:window:window-a");
    expect(secondScope).toBe("thread-1:browser:right:window:window-b");
    expect(secondScope).not.toBe(firstScope);
  });

  it("reads the owning thread id from scoped and legacy browser ids", () => {
    expect(resolveBrowserThreadIdFromScopeId("thread-1:browser:right")).toBe("thread-1");
    expect(resolveBrowserThreadIdFromScopeId("thread-1:browser:right:window:window-a")).toBe(
      "thread-1",
    );
    expect(resolveBrowserThreadIdFromScopeId("thread-1")).toBeNull();
  });
});
