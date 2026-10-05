import { expect, test } from "vitest";
import { displayCommand, stepPath, unwrapShellCommand } from "./step-display.ts";
import { mcpToolLabel, namedToolLabel, toolDisplayName } from "./tool-labels.ts";

const cwd = "/Users/ada/.ace-next/worktrees/33594883e2b3ea4fc70aeea5/repo";

test("paths inside the working directory read relative to it", () => {
  expect(stepPath(`${cwd}/apps/web/src/app.tsx`, { cwd }).text).toBe("apps/web/src/app.tsx");
  expect(stepPath(`${cwd}/apps/web/src/app.tsx`, { cwd }).full).toBe(`${cwd}/apps/web/src/app.tsx`);
});

test("the working directory itself reads by where it is, not as '.'", () => {
  expect(stepPath("/Users/ada/code/relay", { cwd: "/Users/ada/code/relay" }).text).toBe(
    "~/code/relay",
  );
});

test("a skill's files read as the skill's name", () => {
  const path = stepPath("/Users/ada/.agents/skills/diagnosing-bugs/SKILL.md", { cwd });
  expect(path).toMatchObject({ text: "diagnosing-bugs", skill: "diagnosing-bugs" });
  expect(stepPath("/Users/ada/.claude/skills/tdd/SKILL.md").skill).toBe("tdd");
});

test("another worktree of the project is named by its branch", () => {
  const worktrees = [{ path: "/Users/ada/.ace-next/worktrees/abc", branch: "ace/fix-login" }];
  expect(stepPath("/Users/ada/.ace-next/worktrees/abc/src/x.ts", { cwd, worktrees }).text).toBe(
    "[ace/fix-login] src/x.ts",
  );
});

test("an ace worktree path with no working directory known reads from the worktree's root", () => {
  expect(stepPath(`${cwd}/src/math.ts`).text).toBe("repo/src/math.ts");
});

test("elsewhere under home reads ~/…, outside home stays absolute", () => {
  expect(stepPath("/Users/ada/notes/todo.md", { cwd: "/Users/ada/code/app" }).text).toBe(
    "~/notes/todo.md",
  );
  expect(stepPath("/etc/hosts", { cwd: "/Users/ada/code/app" }).text).toBe("/etc/hosts");
});

test("long relative paths keep their first and last segments", () => {
  const text = stepPath(`${cwd}/packages/ui-core/src/deeply/nested/folder/of/things/file.ts`, {
    cwd,
  }).text;
  expect(text).toBe("packages/…/things/file.ts");
});

test("a login-shell wrapper unwraps to the command inside it", () => {
  expect(unwrapShellCommand("/bin/zsh -lc 'bun install --frozen-lockfile'")?.inner).toBe(
    "bun install --frozen-lockfile",
  );
  expect(unwrapShellCommand(`/bin/zsh -lc "tail -10 /tmp/seed.log; rg -n 'a|b' src"`)?.inner).toBe(
    "tail -10 /tmp/seed.log; rg -n 'a|b' src",
  );
  expect(unwrapShellCommand(`bash -c 'echo '\\''hi'\\'''`)?.inner).toBe("echo 'hi'");
  expect(unwrapShellCommand(`/bin/zsh -lc "echo \\"quoted\\""`)?.inner).toBe('echo "quoted"');
});

test("anything but the exact wrapper form is left as written", () => {
  expect(unwrapShellCommand("bun install")).toBeUndefined();
  expect(unwrapShellCommand("/bin/zsh -lc 'ls' && rm -rf /")).toBeUndefined();
  expect(unwrapShellCommand("/bin/zsh -lc 'unterminated")).toBeUndefined();
  expect(unwrapShellCommand("/bin/zsh -x -lc 'ls'")).toBeUndefined();
  expect(unwrapShellCommand("python -c 'print(1)'")).toBeUndefined();
});

test("a shell step shows the readable command and keeps the raw one for the detail", () => {
  expect(displayCommand({ command: "/bin/zsh -lc 'pwd'" })).toEqual({
    command: "pwd",
    raw: "/bin/zsh -lc 'pwd'",
  });
  expect(displayCommand({ command: "pwd", rawCommand: "/bin/bash -lc pwd" })).toEqual({
    command: "pwd",
    raw: "/bin/bash -lc pwd",
  });
  expect(displayCommand({ command: "pwd" })).toEqual({ command: "pwd" });
});

test("approval tools are named for what they do, never by a raw method", () => {
  expect(toolDisplayName("item/commandExecution/requestApproval")).toBe("Command");
  expect(toolDisplayName("Bash")).toBe("Command");
  expect(toolDisplayName("item/fileChange/requestApproval")).toBe("File change");
  expect(toolDisplayName("codex-permissions-escalation")).toBe("Permission escalation");
  expect(toolDisplayName("WebFetch")).toBe("Web request");
  expect(toolDisplayName("mcp__github__create_issue")).toBe("github · create issue");
  expect(toolDisplayName(undefined)).toBe("Action");
  expect(toolDisplayName("item/unknown/requestApproval")).toBe("Action");
});

test("ace's own tools read as what they did, with their key argument", () => {
  expect(
    mcpToolLabel("ace", "ace_browser_open", { url: "https://www.youtube.com/" }),
  ).toMatchObject({ verb: "Opened", target: "youtube.com", running: "Opening" });
  expect(mcpToolLabel("ace", "ace_spawn_agent", { role: "greeter" })).toMatchObject({
    verb: "Started a subagent",
    target: "greeter",
  });
  expect(mcpToolLabel("ace", "ace_thread_read", { threadId: "thread-1" }).verb).toBe("Read thread");
});

test("other servers read 'server › tool' with their key argument; computer use is named", () => {
  expect(mcpToolLabel("docs", "search_pages", { query: "TypeScript" })).toMatchObject({
    verb: "Called",
    target: "docs › search pages TypeScript",
  });
  expect(mcpToolLabel("cua_repl", "js", { code: "1+1" }).verb).toBe("Ran a computer-use script");
  expect(namedToolLabel("custom", "Skill")).toMatchObject({ verb: "Used", target: "Skill" });
  expect(namedToolLabel("browser", "Pair a phone")).toMatchObject({ verb: "Browsed", icon: "web" });
});
