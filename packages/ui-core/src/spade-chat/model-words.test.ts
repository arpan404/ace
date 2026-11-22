import { describe, expect, it } from "vitest";
import { spadeModelLabel } from "./index.ts";

const none = { endpoints: [], subscriptions: [], forBots: false };

describe("a saved model no source lists now", () => {
  it("reads as words, never as its id", () => {
    expect(spadeModelLabel(none, "openrouter/saved/model").name).toBe("Model");
    expect(spadeModelLabel(none, "openrouter/claude-sonnet-5").name).toBe("Claude sonnet 5");
  });
});
