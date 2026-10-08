import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerInstructions } from "@ace/mcp-server";

/** A private additional workspace carries an always-applied native Cursor rule.
 * Keep the project and Cursor's built-in system prompt intact; never write credentials. */
export async function cursorToolGuidance() {
  const directory = await mkdtemp(join(tmpdir(), "ace-cursor-guidance-"));
  try {
    const rules = join(directory, ".cursor", "rules");
    await mkdir(rules, { recursive: true, mode: 0o700 });
    await writeFile(
      join(rules, "ace.mdc"),
      `---\ndescription: ace tool routing for this thread\nalwaysApply: true\n---\n${developerInstructions("cursor")}\n`,
      { mode: 0o600 },
    );
    return { directory, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
