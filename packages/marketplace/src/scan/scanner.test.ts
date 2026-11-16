import { describe, expect, it } from "vitest";
import type { MarketBlocklist, MarketScanFinding } from "@ace/protocol/marketplace";
import { checkFiles } from "../checks/index.ts";
import { sha256Hex } from "../hash.ts";
import { folder } from "../testing.ts";
import { filesCheck } from "./checks-files.ts";
import { knownBadFindings } from "./checks-knownbad.ts";
import { sceneCheck } from "./checks-scene.ts";
import {
  disposition,
  finishScan,
  report,
  requestBudget,
  scanEntry,
  scanStep,
  startScan,
  type ScanContext,
  type ScanInput,
} from "./index.ts";

/*
 * The scanner's own checks (files, hidden, scene, known-bad), its report, its disposition and its
 * budgeted steps. Behaviour: given files, the right findings come back; a block refuses, a warn
 * holds; and a scan read in small budgeted steps, round-tripped through JSON, reaches the same
 * report as a whole scan.
 */

const bytes = (...values: number[]) => new Uint8Array(values);
const context: ScanContext = { entries: [], verified: [] };

function inputFrom(
  type: ScanInput["type"],
  name: string,
  files: Record<string, string | Uint8Array>,
): ScanInput {
  const archive = folder(files);
  const checked = checkFiles(type, name, archive);
  return {
    type,
    name,
    files: archive,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  };
}

const rules = (findings: readonly MarketScanFinding[]) => findings.map((f) => f.rule);

describe("the files check", () => {
  it("blocks a native program by its magic bytes", () => {
    const findings = filesCheck(
      "spade-skill",
      folder({ "bin/tool": bytes(0x7f, 0x45, 0x4c, 0x46, 1, 1) }),
    );
    expect(findings.some((f) => f.rule === "native-binary" && f.level === "block")).toBe(true);
  });

  it("blocks an archive nested inside the entry", () => {
    const findings = filesCheck(
      "spade-skill",
      folder({ "data.zip": bytes(0x50, 0x4b, 0x03, 0x04, 0, 0) }),
    );
    expect(findings.some((f) => f.rule === "nested-archive" && f.level === "block")).toBe(true);
  });

  it("blocks a WebAssembly module outside a plugin but allows it inside one", () => {
    const wasm = { "mod.wasm": bytes(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0) };
    expect(rules(filesCheck("suit", folder(wasm)))).toContain("wasm-outside-plugin");
    expect(rules(filesCheck("spade-plugin", folder(wasm)))).not.toContain("wasm-outside-plugin");
  });

  it("blocks a stray file in a Suit", () => {
    const findings = filesCheck("suit", folder({ "suit.json": "{}", "run.py": "print(1)" }));
    expect(findings.some((f) => f.rule === "suit-stray-file" && f.path === "run.py")).toBe(true);
  });

  it("warns on an executable bit where the type has none", () => {
    const findings = filesCheck("spade-skill", folder({ "notes.txt*": "hello" }));
    expect(findings.some((f) => f.rule === "executable-bit" && f.level === "warn")).toBe(true);
  });
});

describe("the scene check", () => {
  it("blocks a scene that reaches the network", () => {
    const findings = sceneCheck(
      folder({ "scene.js": "export function scene(){ fetch('https://x') }" }),
    );
    expect(findings.some((f) => f.rule === "scene-fetch" && f.level === "block")).toBe(true);
  });

  it("passes a scene that only draws", () => {
    const findings = sceneCheck(
      folder({
        "scene.js": "export function scene(ctx,{width,height}){ ctx.fillRect(0,0,width,height) }",
      }),
    );
    expect(findings).toHaveLength(0);
  });
});

describe("the hidden check through a whole scan", () => {
  it("blocks a bidirectional control character in a file", () => {
    const made = scanEntry(
      inputFrom("spade-skill", "x", {
        "SKILL.md": "---\nname: x\ndescription: a skill that does a thing well.\n---\nok",
        "scripts/run.py": "x = 1  # ‮ evil",
      }),
    );
    expect(made.findings.some((f) => f.check === "hidden" && f.level === "block")).toBe(true);
  });

  it("warns on a name that typosquats another publisher's entry", () => {
    const seeded: ScanContext = {
      entries: [
        { type: "spade-skill", name: "triage-mail", publisher: "someone-else", downloads: 100 },
      ],
      verified: [],
      publisher: { handle: "me", official: false },
    };
    const input = inputFrom("spade-skill", "triage-mail", {
      "SKILL.md": "---\nname: triage-mail\ndescription: sorts the inbox into replies.\n---\nok",
    });
    const made = scanEntry({ ...input, context: seeded });
    expect(made.findings.some((f) => f.rule === "typosquat-entry")).toBe(true);
  });
});

describe("the known-bad check", () => {
  const files = folder({ "run.sh": "#!/bin/sh\necho hello world\n" });
  it("blocks a file whose sha256 is on the blocklist", () => {
    const sha = sha256Hex(files[0]!.content);
    const blocklist: MarketBlocklist = {
      format: "ace-market-blocklist",
      issued: 1,
      hashes: [],
      files: [{ sha256: sha, reason: "known dropper" }],
      patterns: [],
      key: "k1",
    };
    expect(rules(knownBadFindings(files, "deadbeef", blocklist))).toContain("blocked-file");
  });

  it("blocks a file matching a blocked pattern, case-insensitively", () => {
    const blocklist: MarketBlocklist = {
      format: "ace-market-blocklist",
      issued: 1,
      hashes: [],
      files: [],
      patterns: [{ id: "p1", text: "HELLO WORLD", reason: "marker string" }],
      key: "k1",
    };
    expect(
      knownBadFindings(files, "x", blocklist).some((f) => f.rule === "blocked-pattern-p1"),
    ).toBe(true);
  });
});

describe("report", () => {
  it("takes the strongest finding as the verdict and names each check", () => {
    const made = report(
      [
        { check: "scripts", rule: "a", level: "warn", message: "one" },
        { check: "files", rule: "b", level: "block", message: "two" },
      ],
      { files: 2, textBytes: 10 },
    );
    expect(made.verdict).toBe("block");
    expect(made.checks.find((c) => c.id === "files")?.verdict).toBe("block");
    expect(made.checks.find((c) => c.id === "secrets")?.verdict).toBe("pass");
  });
});

const reportWith = (level: MarketScanFinding["level"], strict = false) =>
  report(
    [{ check: "scripts", rule: "r", level, message: "m", ...(strict ? { strict: true } : {}) }],
    {
      files: 1,
      textBytes: 1,
    },
  );

describe("disposition", () => {
  const base = { newPublisher: false, firstVersion: false, official: false, approved: false };

  it("refuses a block", () => {
    expect(disposition(reportWith("block"), base)).toBe("block");
  });
  it("holds a warn unless the version was approved", () => {
    expect(disposition(reportWith("warn"), base)).toBe("hold");
    expect(disposition(reportWith("warn"), { ...base, approved: true })).toBe("list");
  });
  it("lists a clean entry", () => {
    expect(disposition(reportWith("note"), base)).toBe("list");
  });
  it("holds a new publisher's first version", () => {
    expect(
      disposition(reportWith("note"), { ...base, newPublisher: true, firstVersion: true }),
    ).toBe("hold");
  });
  it("holds every official version", () => {
    expect(disposition(reportWith("note"), { ...base, official: true })).toBe("hold");
  });
  it("holds a strict note only for a new publisher", () => {
    expect(disposition(reportWith("note", true), { ...base, newPublisher: true })).toBe("hold");
    expect(disposition(reportWith("note", true), base)).toBe("list");
  });
});

describe("budgeted steps", () => {
  const input = inputFrom("spade-plugin", "big", {
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: "big",
      version: "1.0.0",
      description: "d",
    }),
    "a.sh": "#!/bin/sh\necho a\n",
    "b.py": "print('b')\n",
    "c.js": "console.log('c')\n",
  });

  it("reaches the same report whether read whole or in JSON-round-tripped steps", () => {
    const whole = scanEntry(input);

    let state = startScan();
    let done = false;
    let steps = 0;
    const tinyBudget = { textBytes: 1, files: 1 };
    while (!done) {
      const revived = JSON.parse(JSON.stringify(state)) as typeof state;
      const out = scanStep(revived, input, tinyBudget);
      state = out.state;
      done = out.done;
      if (++steps > 100) throw new Error("step budget never finished");
    }
    const stepped = finishScan(JSON.parse(JSON.stringify(state)), input);

    expect(stepped.verdict).toBe(whole.verdict);
    expect(stepped.findings.map((f) => f.rule).toSorted()).toEqual(
      whole.findings.map((f) => f.rule).toSorted(),
    );
    expect(stepped.read.files).toBe(whole.read.files);
    expect(steps).toBeGreaterThan(1);
  });

  it("stops within the request budget's file count on one step", () => {
    const out = scanStep(startScan(), input, requestBudget);
    expect(out.state.files).toBeLessThanOrEqual(requestBudget.files);
  });
});

describe("cost", () => {
  it("scans a one-megabyte adversarial line fast", () => {
    const input = inputFrom("spade-skill", "big", {
      "SKILL.md": "---\nname: big\ndescription: a skill with a very long line.\n---\nok",
      "scripts/x.sh": `#!/bin/sh\necho ${"A".repeat(1024 * 1024)}\n`,
    });
    const started = performance.now();
    const made = scanEntry(input);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(made.findings.some((f) => f.rule === "too-long")).toBe(true);
  });
});
