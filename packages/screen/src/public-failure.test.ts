import { expect, test } from "vitest";
import { toolFailure } from "@ace/mcp-server";
import { HelperCommandError } from "./helper.ts";
import { screenPublicFailure } from "./public-failure.ts";

test.each([
  [
    "permission_denied",
    "Windows session 0 cannot access the person's desktop. Run ace in your signed-in session, not as a service in session 0.",
  ],
  [
    "busy",
    "Windows session is not actively connected. Sign in or reconnect to this session, then retry.",
  ],
])("MCP preserves reviewed %s session recovery guidance", (code, message) => {
  const result = toolFailure(
    screenPublicFailure(new HelperCommandError(code, message, "rejected-before-dispatch")),
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain(message);
  expect(JSON.stringify(result)).toContain("rejected-before-dispatch");
});

test("unreviewed helper messages with known codes remain private in MCP failures", () => {
  const result = toolFailure(
    screenPublicFailure(
      new HelperCommandError(
        "permission_denied",
        "Private diagnostic with opaque-credential and a host path",
      ),
    ),
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("opaque-credential");
});
