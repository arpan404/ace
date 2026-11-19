import { expect, test } from "vitest";
import { splitCommand } from "./command-line.ts";

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
