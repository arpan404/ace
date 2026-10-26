import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchEditorCommand } from "./editor-command.ts";

let folder = "";
let file = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ace-editor-command-"));
  file = join(folder, "naïve #?%.ts");
  writeFileSync(file, "");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

/** A stand-in launcher that records the arguments it was run with. */
function launcher(name: string): { command: string; args: () => string[] | undefined } {
  const command = join(folder, name);
  const record = `${command}.args`;
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}.tmp'\nmv '${record}.tmp' '${record}'\n`,
  );
  chmodSync(command, 0o700);
  return {
    command,
    args: () =>
      existsSync(record) ? readFileSync(record, "utf8").split("\n").slice(0, -1) : undefined,
  };
}

describe("Linux editor launchers", () => {
  it.each([
    ["code", ["-g", "FILE:12:3"]],
    ["cursor", ["-g", "FILE:12:3"]],
    ["zeditor", ["FILE:12:3"]],
    ["subl", ["FILE:12:3"]],
    ["idea.sh", ["--line", "12", "--column", "3", "FILE"]],
  ])("runs %s at the file's line and column", async (name, expected) => {
    const editor = launcher(name);
    const launched = await launchEditorCommand(
      { path: file, line: 12, column: 3, command: editor.command },
      "linux",
    );
    expect(launched).toBe(true);
    await vi.waitFor(() =>
      expect(editor.args()).toEqual(expected.map((arg) => arg.replace("FILE", file))),
    );
  });

  it("opens a folder without a position", async () => {
    const editor = launcher("code");
    expect(await launchEditorCommand({ path: folder, command: editor.command }, "linux")).toBe(
      true,
    );
    await vi.waitFor(() => expect(editor.args()).toEqual([folder]));
  });

  it("refuses a program that isn't an editor launcher, leaving the URL scheme to open it", async () => {
    const other = launcher("sh-helper");
    expect(await launchEditorCommand({ path: file, command: other.command }, "linux")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(other.args()).toBeUndefined();
  });

  it("falls back when the daemon's launcher isn't on this computer", async () => {
    const command = join(folder, "missing", "code");
    expect(await launchEditorCommand({ path: file, command }, "linux")).toBe(false);
  });

  it("falls back when the launcher isn't executable", async () => {
    const editor = launcher("zed");
    chmodSync(editor.command, 0o600);
    expect(await launchEditorCommand({ path: file, command: editor.command }, "linux")).toBe(false);
  });

  it("leaves macOS to the editor's URL scheme", async () => {
    const editor = launcher("code");
    expect(await launchEditorCommand({ path: file, command: editor.command }, "darwin")).toBe(
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(editor.args()).toBeUndefined();
  });
});
