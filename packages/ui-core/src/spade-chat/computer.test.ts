import { describe, expect, test } from "vitest";
import {
  parseSpadeAgents,
  parseSpadeComputer,
  parseSpadeTerminalFrame,
  spadeBase64,
  spadeComputerTabs,
  spadeLiveSurfaces,
  spadeSurfaceHeading,
  spadeSurfaceLine,
} from "./index.ts";

const computer = (surfaces: unknown[], driver = "bot") => parseSpadeComputer({ driver, surfaces });

describe("a bot's computer", () => {
  test("is shared unless Spade says the person has it alone; an older Spade's person driving is exclusive", () => {
    expect(parseSpadeComputer({ mode: "cowork", driver: "bot", surfaces: [] })?.mode).toBe(
      "cowork",
    );
    expect(parseSpadeComputer({ mode: "exclusive", driver: "person", surfaces: [] })?.mode).toBe(
      "exclusive",
    );
    expect(computer([], "person")?.mode).toBe("exclusive");
    expect(computer([])?.mode).toBe("cowork");
    const yielding = computer([{ kind: "browser", live: true, person_active: true }]);
    expect(yielding?.surfaces[0]?.personActive).toBe(true);
  });

  test("keeps the surfaces it knows and drops the rest, reading null fields as nothing", () => {
    const parsed = computer([
      { kind: "browser", live: true, title: null, since: null, url: "https://www.staybook.com/x" },
      { kind: "printer", live: true },
      { kind: "terminal", live: false, last: 1_000 },
    ]);
    expect(parsed?.surfaces.map((surface) => surface.kind)).toEqual(["browser", "terminal"]);
    expect(parsed?.surfaces[0]?.title).toBeUndefined();
    expect(parsed?.surfaces[1]?.last).toBe(1_000);
  });

  test("a terminal still ending its last command says so instead of its title", () => {
    const [terminal] = computer([
      { kind: "terminal", live: true, title: "npm test", ending_stuck: true },
    ])!.surfaces;
    expect(spadeSurfaceLine(terminal!)).toBe("Still ending the last command");
    const [plain] = computer([{ kind: "terminal", live: true, title: "npm test" }])!.surfaces;
    expect(spadeSurfaceLine(plain!)).toBe("npm test");
  });

  test("is driven by the person only when Spade says so", () => {
    expect(computer([], "person")?.driver).toBe("person");
    expect(computer([], "someone")?.driver).toBe("bot");
  });

  test("lists what is live browser first, and never files", () => {
    const live = spadeLiveSurfaces(
      computer([
        { kind: "terminal", live: true },
        { kind: "files", live: true },
        { kind: "browser", live: true },
        { kind: "screen", live: false },
      ]),
    );
    expect(live.map((surface) => surface.kind)).toEqual(["browser", "terminal"]);
  });

  test("offers what is in use and Files, and keeps the open surface after the bot is done", () => {
    const done = computer([
      { kind: "browser", live: false },
      { kind: "terminal", live: true },
    ]);
    expect(spadeComputerTabs(done, undefined)).toEqual(["terminal", "files"]);
    expect(spadeComputerTabs(done, "browser")).toEqual(["browser", "terminal", "files"]);
    expect(spadeComputerTabs(undefined, undefined)).toEqual(["files"]);
  });

  test("names the browser by its host and the screen by its machine", () => {
    const [browser, screen] = computer([
      { kind: "browser", live: true, url: "https://www.staybook.com/lisbon" },
      { kind: "screen", live: true },
    ])!.surfaces;
    expect(spadeSurfaceHeading(browser!, "This Mac")).toBe("Browser · staybook.com");
    expect(spadeSurfaceHeading(screen!, "This Mac")).toBe("Screen · This Mac");
  });

  test("comes with each agent in the list", () => {
    const agents = parseSpadeAgents(
      JSON.stringify({
        agents: [
          {
            id: "a",
            conversation: "c",
            computer: { driver: "bot", surfaces: [{ kind: "screen", live: true }] },
          },
          { id: "b", conversation: "d" },
        ],
      }),
    );
    expect(spadeLiveSurfaces(agents?.[0]?.computer).map((s) => s.kind)).toEqual(["screen"]);
    expect(agents?.[1]?.computer).toBeUndefined();
  });
});

describe("a bot's terminal stream", () => {
  test("reads output as bytes in order of seq", () => {
    const data = spadeBase64(new TextEncoder().encode("ls\r\n"));
    const frame = parseSpadeTerminalFrame("output", JSON.stringify({ seq: 7, data_b64: data }));
    expect(frame?.kind === "output" && new TextDecoder().decode(frame.data)).toBe("ls\r\n");
    expect(frame?.kind === "output" && frame.seq).toBe(7);
  });

  test("reads a size and an exit, and leaves out what it can't read", () => {
    expect(parseSpadeTerminalFrame("resize", '{"cols":80,"rows":24}')).toEqual({
      kind: "resize",
      cols: 80,
      rows: 24,
    });
    expect(parseSpadeTerminalFrame("exit", '{"code":null}')).toEqual({
      kind: "exit",
      code: undefined,
    });
    expect(parseSpadeTerminalFrame("output", '{"seq":1,"data_b64":"%%"}')).toBeUndefined();
    expect(parseSpadeTerminalFrame("bell", "{}")).toBeUndefined();
  });
});
