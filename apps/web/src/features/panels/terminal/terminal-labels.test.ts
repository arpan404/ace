import { expect, test } from "vitest";
import { terminalName } from "./daemon-terminals.ts";
import { distinctLabels } from "./use-terminals.ts";

test("terminal tabs with the same name read apart", () => {
  const labels = distinctLabels([
    { label: "dev:relay" },
    { label: "soak" },
    { label: "dev:relay" },
    { label: "dev:relay" },
  ]).map((tab) => tab.label);
  expect(labels).toEqual(["dev:relay", "soak", "dev:relay 2", "dev:relay 3"]);
});

const running = (...names: string[]) =>
  names.map((name, index) => ({ id: `t${index}`, threadId: "t", name, exited: false }));

test("a new terminal is named after the shell the thread's terminals run, with an ordinal", () => {
  expect(terminalName(running("zsh"))).toBe("zsh 2");
  expect(terminalName(running("zsh", "dev:relay", "zsh 2"))).toBe("zsh 3");
});

test("without a shell-named terminal, new ones are Terminal, Terminal 2, ...", () => {
  expect(terminalName([])).toBe("Terminal");
  expect(terminalName(running("dev:relay", "Terminal"))).toBe("Terminal 2");
});
