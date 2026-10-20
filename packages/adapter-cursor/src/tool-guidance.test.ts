import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { developerInstructions } from "@ace/mcp-server";
import { cursorToolGuidance } from "./tool-guidance.ts";

const rule = async (guidance: Awaited<ReturnType<typeof cursorToolGuidance>>) =>
  readFile(join(guidance.directory, ".cursor/rules/ace.mdc"), "utf8");

test("Cursor's always-applied rule carries the session's own guidance, roles included", async () => {
  const roles = "Roles: verify claude opus-5.5. Delegate with runRole.";
  const session = await cursorToolGuidance(developerInstructions("cursor", { roles }));
  const plain = await cursorToolGuidance();
  try {
    expect(await rule(session)).toContain(roles);
    expect(await rule(plain)).toContain(developerInstructions("cursor"));
    expect(await rule(plain)).not.toContain("Roles:");
  } finally {
    await session.close();
    await plain.close();
  }
});
