import { describe, expect, it } from "vitest";

import {
  inferOrchestrationMessageTextMode,
  resolveOrchestrationMessageText,
} from "./orchestrationMessageText";

describe("orchestrationMessageText", () => {
  it("resolves append, replace, and complete message text modes", () => {
    expect(
      resolveOrchestrationMessageText({
        previousText: "hello",
        incomingText: " world",
        textMode: "append",
      }),
    ).toBe("hello world");
    expect(
      resolveOrchestrationMessageText({
        previousText: "hello",
        incomingText: "",
        textMode: "replace",
      }),
    ).toBe("");
    expect(
      resolveOrchestrationMessageText({
        previousText: "hello",
        incomingText: "",
        textMode: "complete",
      }),
    ).toBe("hello");
  });

  it("infers the legacy stream contract when textMode is absent", () => {
    expect(inferOrchestrationMessageTextMode({ streaming: true })).toBe("append");
    expect(inferOrchestrationMessageTextMode({ streaming: false })).toBe("complete");
  });
});
