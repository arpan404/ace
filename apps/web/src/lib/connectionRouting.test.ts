import { describe, expect, it } from "vitest";

import {
  resolveConnectionForInput,
  stripRpcRouteConnection,
  withRpcRouteConnection,
} from "./connectionRouting";

describe("RPC route connection metadata", () => {
  it("routes by explicit RPC connection metadata and strips it before transport", () => {
    const input = withRpcRouteConnection(
      {
        cwd: "/tmp/project",
        relativePath: "src/App.tsx",
      },
      "ws://remote.example/ws",
    );

    expect(resolveConnectionForInput(input)).toBe("ws://remote.example/ws");
    expect(stripRpcRouteConnection(input)).toEqual({
      cwd: "/tmp/project",
      relativePath: "src/App.tsx",
    });
  });

  it("does not add empty connection metadata", () => {
    const input = { cwd: "/tmp/project" };

    expect(withRpcRouteConnection(input, null)).toBe(input);
    expect(stripRpcRouteConnection(input)).toBe(input);
  });
});
