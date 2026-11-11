import plist from "plist";
import { expect, test } from "vitest";
import { renderSpadeCmdLauncher, spadeServicePlan } from "./spade-plan.ts";

const account = { userHome: "/Users/someone", uid: 501 };

test("launchd keeps Spade alive from the current binary with exactly Spade's environment", () => {
  const plan = spadeServicePlan("/Users/someone/.ace", "darwin", account);
  expect(plan.file).toBe("/Users/someone/Library/LaunchAgents/dev.ace.next.spade.plist");
  const parsed = plist.parse(plan.content) as Record<string, unknown>;
  expect(parsed).toEqual({
    Label: "dev.ace.next.spade",
    ProgramArguments: ["/Users/someone/.ace/releases/spade/current/spade-server"],
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 15,
    EnvironmentVariables: {
      SPADE_DATA_DIR: "/Users/someone/.ace/spade",
      SPADE_ACE_HOME: "/Users/someone/.ace",
      SPADE_LISTEN: "127.0.0.1:0",
      RUST_LOG: "info",
    },
    StandardOutPath: "/Users/someone/.ace/logs/spade.log",
    StandardErrorPath: "/Users/someone/.ace/logs/spade.log",
  });
});

test("a home with XML characters stays one plist string", () => {
  const plan = spadeServicePlan("/Users/someone/a&b<c>", "darwin", account);
  const parsed = plist.parse(plan.content) as { ProgramArguments: string[] };
  expect(parsed.ProgramArguments).toEqual([
    "/Users/someone/a&b<c>/releases/spade/current/spade-server",
  ]);
});

test("systemd restarts Spade on failure after a second, but not a second instance's exit 3", () => {
  const plan = spadeServicePlan("/home/someone/.ace", "linux", { userHome: "/home/someone" });
  expect(plan.file).toBe("/home/someone/.config/systemd/user/ace-next-spade.service");
  const lines = plan.content.split("\n");
  expect(lines).toContain('ExecStart="/home/someone/.ace/releases/spade/current/spade-server"');
  expect(lines).toContain(
    'Environment="SPADE_DATA_DIR=/home/someone/.ace/spade" "SPADE_ACE_HOME=/home/someone/.ace" "SPADE_LISTEN=127.0.0.1:0" "RUST_LOG=info"',
  );
  expect(lines).toContain("Restart=on-failure");
  expect(lines).toContain("RestartSec=1");
  expect(lines).toContain("RestartPreventExitStatus=3");
  expect(lines).toContain("StandardOutput=append:/home/someone/.ace/logs/spade.log");
});

test("systemd specifiers and variables in the home are escaped, not expanded", () => {
  const plan = spadeServicePlan("/home/someone/50% $HOME", "linux", { userHome: "/home/someone" });
  expect(plan.content).toContain('ExecStart="/home/someone/50%% $$HOME/releases/spade/current/');
  expect(plan.content).toContain("StandardError=append:/home/someone/50%% $HOME/logs/spade.log");
});

test("Windows registers a logon task that runs the home's spade launcher hidden", () => {
  const plan = spadeServicePlan("C:\\Users\\someone\\.ace", "win32", {
    userHome: "C:\\Users\\someone",
    sid: "S-1-5-21-1-2-3-1001",
    systemRoot: "C:\\Windows",
  });
  if (plan.platform !== "win32") throw new Error("expected a task plan");
  expect(plan.name).toBe("\\ace-next-spade");
  expect(plan.file).toBe("C:\\Users\\someone\\.ace\\service\\spade-task.xml");
  expect(plan.content).toContain(
    "<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1-2-3-1001",
  );
  expect(plan.content).toContain("<RestartOnFailure>");
  expect(plan.content).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
  expect(plan.arguments).toBe(
    '--headless "C:\\Windows\\System32\\cmd.exe" /d /c @ "C:\\Users\\someone\\.ace\\bin\\spade.cmd"',
  );
  expect(plan.launcher.content).toBe(renderSpadeCmdLauncher());
});

/** Names a `set "NAME=…"` in `line` assigns, in order. */
const assigned = (line: string) => [...line.matchAll(/set "([^="]+)=/g)].map((m) => m[1]);

test("the Windows launcher hands Spade exactly its four variables and no ACE_ ones", () => {
  const lines = renderSpadeCmdLauncher().split("\r\n");
  const local = lines.indexOf("setlocal DisableDelayedExpansion");
  const exec = lines.findIndex((line) => line.includes("spade-server.exe"));
  // The person's ACE_* and SPADE_* are cleared before anything else.
  expect(lines.slice(1, local)).toEqual([
    `for /f "delims==" %%V in ('set ACE_ 2^>nul') do set "%%V="`,
    `for /f "delims==" %%V in ('set SPADE_ 2^>nul') do set "%%V="`,
  ]);
  // The launcher's own variables live only inside setlocal and are never ACE_ or SPADE_ ones.
  for (const line of lines.slice(local + 1, exec))
    for (const name of assigned(line)) expect(name).not.toMatch(/^(ACE_|SPADE_|RUST_)/i);
  // One line ends setlocal, then sets exactly Spade's four and starts it, logging to spade.log.
  const run = lines[exec] ?? "";
  expect(run.startsWith("endlocal & ")).toBe(true);
  expect(assigned(run)).toEqual(["SPADE_DATA_DIR", "SPADE_ACE_HOME", "SPADE_LISTEN", "RUST_LOG"]);
  expect(run).toContain('set "SPADE_DATA_DIR=%SPADELAUNCH_HOME%\\spade"');
  expect(run).toContain('set "SPADE_ACE_HOME=%SPADELAUNCH_HOME%"');
  expect(run).toMatch(/spade-server\.exe" >>"%SPADELAUNCH_LOG%" 2>&1$/);
  expect(lines.slice(exec + 1)).toEqual(["exit /b %ERRORLEVEL%", ""]);
});

test("the Windows launcher rotates spade.log before Spade holds it open", () => {
  const lines = renderSpadeCmdLauncher().split("\r\n");
  const rotate = lines.findIndex((line) => line.includes('.previous"'));
  const exec = lines.findIndex((line) => line.includes("spade-server.exe"));
  expect(rotate).toBeGreaterThan(0);
  expect(rotate).toBeLessThan(exec);
  expect(lines[rotate]).toContain("GTR 8388608");
});

test("plans refuse homes the service manager would read differently", () => {
  expect(() => spadeServicePlan("relative/.ace", "linux", { userHome: "/home/a" })).toThrow();
  expect(() =>
    spadeServicePlan("/home/a/.ace\nExecStartPre=/bin/x", "linux", { userHome: "/home/a" }),
  ).toThrow();
  expect(() =>
    spadeServicePlan("C:\\Users\\100%\\.ace", "win32", {
      userHome: "C:\\Users\\a",
      sid: "S-1-5-21-1",
    }),
  ).toThrow();
  expect(() => spadeServicePlan("/Users/a/.ace", "darwin", { userHome: "/Users/a" })).toThrow();
});
