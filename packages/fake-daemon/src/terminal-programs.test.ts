import { describe, expect, it } from "vitest";
import { FakeTerminals } from "./terminals.ts";

function shell() {
  const terminals = new FakeTerminals({ capacity: 1024 * 1024 });
  const info = terminals.openNow({ threadId: "t", cwd: "/repo", cols: 60, rows: 20 });
  let output = "";
  terminals.attach(info.id, 0, (event) => {
    if (event.type === "data") output += event.data;
  });
  const type = (text: string) => {
    output = "";
    terminals.write(info.id, text);
    return output;
  };
  return { type };
}

describe("the fake shell's terminal programs", () => {
  it("runs top on the alternate screen with cursor keys, and returns to the prompt on q", () => {
    const { type } = shell();
    const started = type("top\r");
    expect(started).toContain("\x1b[?1049h");
    expect(started).toContain("\x1b[?1h");
    expect(started).toContain("vitest run apps/server");
    // An arrow in application mode moves the highlight to the second process.
    const moved = type("\x1bOB");
    expect(moved).toMatch(/\x1b\[7m\s+388/);
    const quit = type("q");
    expect(quit).toContain("\x1b[?1049l");
    expect(quit).toContain("$ ");
    expect(type("pwd\r")).toContain("/repo");
  });

  it("prints a colour chart and floods output in bounded chunks", () => {
    const { type } = shell();
    const chart = type("colors\r");
    expect(chart).toContain("\x1b[48;5;231m");
    expect(chart).toContain("\x1b[48;2;");
    const flood = type("flood 2000\r");
    expect(flood).toContain("module-2000.ts");
    expect(flood.split("\r\n").length).toBeGreaterThan(2000);
  });
});
