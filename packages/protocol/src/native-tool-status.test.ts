import { expect, test } from "vitest";
import { NativeToolStatus } from "./index.ts";

const tool = (state: unknown) => ({ id: "chrome", label: "Claude in Chrome", state });

test.each(["ready", "unavailable", "unknown"])(
  "a provider tool's %s state reads as itself",
  (state) => {
    expect(NativeToolStatus.parse(tool(state)).state).toBe(state);
  },
);

test.each([["paused"], [7], [null], [undefined]])(
  "a tool state this client doesn't know (%s) reads as unknown, never refusing the status",
  (state) => {
    expect(NativeToolStatus.parse(tool(state)).state).toBe("unknown");
  },
);
