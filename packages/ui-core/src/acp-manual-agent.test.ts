import { expect, test } from "vitest";
import { manualAgent, splitCommand } from "./acp-manual-agent.ts";

test("a command line splits into words the way a shell would", () => {
  expect(splitCommand(`gemini --experimental-acp`)).toEqual(["gemini", "--experimental-acp"]);
  expect(splitCommand(`"/Applications/My Agent/bin/agent" --acp 'two words'`)).toEqual([
    "/Applications/My Agent/bin/agent",
    "--acp",
    "two words",
  ]);
  expect(splitCommand(`agent --name=a\\ b ""`)).toEqual(["agent", "--name=a b", ""]);
  expect(splitCommand(`agent "open`)).toBeNull();
});

test("a named command becomes a local binding that shows exactly what ace will run", () => {
  const check = manualAgent("  My Agent ", `"/opt/my agent/bin/run" --acp`);
  expect(check).toEqual({
    ok: true,
    agent: {
      name: "My Agent",
      acpAgentId: "local:my-agent",
      installationId: "local-my-agent",
      instanceId: "local-my-agent:default",
      version: "local",
      command: "/opt/my agent/bin/run",
      args: ["--acp"],
      display: "'/opt/my agent/bin/run' --acp",
    },
  });
});

test("the form says which field to fix before anything is sent", () => {
  expect(manualAgent("", "gemini")).toMatchObject({ ok: false, field: "name" });
  expect(manualAgent("!!!", "gemini")).toMatchObject({ ok: false, field: "name" });
  expect(manualAgent("Gemini", "  ")).toMatchObject({ ok: false, field: "command" });
  expect(manualAgent("Gemini", `gemini "--acp`)).toMatchObject({
    ok: false,
    field: "command",
    problem: "Close the quote in the command.",
  });
  expect(manualAgent("Gemini", "gemini\n--acp")).toMatchObject({ ok: false, field: "command" });
});

test("package runners are refused because the daemon binds only an installed agent", () => {
  for (const command of ["npx @google/gemini-cli", "/usr/local/bin/bunx agent", "uvx agent"])
    expect(manualAgent("Gemini", command)).toMatchObject({ ok: false, field: "command" });
  expect(manualAgent("Gemini", "/usr/local/bin/gemini --acp")).toMatchObject({ ok: true });
});
