import { expect, it } from "vitest";
import { BrowserCommand } from "@ace/protocol";
import { waitsForPerson } from "./collaboration.ts";

const command = (raw: Record<string, unknown>) => BrowserCommand.parse(raw);

it("an agent's reads answer at once while the person is busy in the tab", () => {
  const reads = [
    { action: "snapshot" },
    { action: "find", role: "button", name: "Save" },
    { action: "logs" },
    { action: "screenshot" },
    { action: "evaluate", expression: "document.title" },
    { action: "wait_for", text: "Ready" },
    { action: "history", direction: "stop" },
  ];
  expect(reads.map((raw) => [raw.action, waitsForPerson(command(raw))])).toEqual(
    reads.map((raw) => [raw.action, false]),
  );
});

it("an agent's input waits for the person to pause", () => {
  const inputs = [
    { action: "click", ref: "e1" },
    { action: "type", ref: "e1", text: "x" },
    { action: "press", key: "Enter" },
    { action: "scroll", x: 0, y: 1 },
    { action: "navigate", url: "http://127.0.0.1/" },
    { action: "history", direction: "back" },
  ];
  expect(inputs.map((raw) => [raw.action, waitsForPerson(command(raw))])).toEqual(
    inputs.map((raw) => [raw.action, true]),
  );
});
