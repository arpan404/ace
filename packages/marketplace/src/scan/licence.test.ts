import { describe, expect, it } from "vitest";
import type { MarketScanFinding } from "@ace/protocol/marketplace";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import { filesCheck } from "./checks-files.ts";
import {
  finishScan,
  scanEntry,
  scanStep,
  startScan,
  type ScanContext,
  type ScanInput,
} from "./index.ts";

/*
 * Licence texts in a Suit (ADR 0174 §8): a font's OFL and a root LICENSE travel with the Suit as
 * inert data. They stay under the hidden-content and secrets checks, are size-capped and UTF-8,
 * never count as runnable, and no other `.txt` is let in.
 */

const context: ScanContext = { entries: [], verified: [] };
const OFL = "Copyright 2024 The Authors. This Font Software is licensed under the SIL OFL 1.1.\n";
const suitJson = JSON.stringify({ id: "licensed", name: "Licensed", version: "1", base: "ace" });

function inputOf(files: Record<string, string | Uint8Array>): ScanInput {
  const archive = folder(files);
  const checked = checkFiles("suit", "licensed", archive);
  return {
    type: "suit",
    name: "licensed",
    files: archive,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  };
}
const rules = (findings: readonly MarketScanFinding[]) => findings.map((f) => f.rule);
const withLicences = (extra: Record<string, string | Uint8Array> = {}) => ({
  "suit.json": suitJson,
  "assets/fonts/X-OFL.txt": OFL,
  LICENSE: OFL,
  ...extra,
});

describe("licence texts in a Suit", () => {
  it("lets a font's OFL and a root LICENSE pass the files check", () => {
    expect(filesCheck("suit", folder(withLicences()))).toEqual([]);
    for (const path of [
      "LICENCE",
      "NOTICE.txt",
      "COPYING",
      "OFL.txt",
      "assets/fonts/OFL.txt",
      "assets/fonts/Inter.LICENSE",
      "assets/fonts/LICENSE.md",
      "assets/LICENSE.txt",
    ])
      expect(filesCheck("suit", folder({ "suit.json": "{}", [path]: OFL })), path).toEqual([]);
  });

  it("scans clean as a whole entry and is not runnable", () => {
    const report = scanEntry(inputOf(withLicences()));
    expect(report.findings.filter((f) => f.level === "block")).toEqual([]);
    expect(report.runnable).toBeFalsy();
  });

  it("still flags bidi or zero-width characters hidden in a licence", () => {
    const bidi = scanEntry(inputOf(withLicences({ LICENSE: `${OFL}‮evil\n` })));
    expect(rules(bidi.findings)).toContain("bidi-control");
    expect(bidi.verdict).toBe("block");
    const zero = scanEntry(inputOf(withLicences({ "assets/fonts/X-OFL.txt": `${OFL}a​b\n` })));
    expect(rules(zero.findings)).toContain("invisible-character");
  });

  it("still blocks a secret inside a licence", () => {
    const report = scanEntry(
      inputOf(withLicences({ NOTICE: `${OFL}-----BEGIN RSA PRIVATE KEY-----\n` })),
    );
    expect(rules(report.findings)).toContain("secret-value");
    expect(report.verdict).toBe("block");
  });

  it("blocks an oversized licence and one that isn't UTF-8 text", () => {
    const big = filesCheck("suit", folder({ LICENSE: "x".repeat(256 * 1024 + 1) }));
    expect(rules(big)).toContain("suit-licence-too-large");
    const ok = filesCheck("suit", folder({ LICENSE: "x".repeat(256 * 1024) }));
    expect(ok).toEqual([]);
    const latin = filesCheck("suit", folder({ LICENSE: new Uint8Array([0x43, 0xe9, 0x20, 0x61]) }));
    expect(rules(latin)).toContain("suit-licence-not-text");
    const bin = filesCheck("suit", folder({ LICENSE: new Uint8Array([0, 1, 2, 3]) }));
    expect(rules(bin)).toContain("suit-licence-not-text");
  });

  it("keeps refusing a .txt or .md that isn't a licence name or place", () => {
    for (const path of [
      "assets/run.txt",
      "notes.txt",
      "README.md",
      "scripts/LICENSE",
      "a/b/LICENSE.txt",
      "licensed-by-me.txt",
      "LICENSE.sh",
      "assets/fonts/OFL.txt.exe",
    ])
      expect(rules(filesCheck("suit", folder({ "suit.json": "{}", [path]: OFL }))), path).toContain(
        "suit-stray-file",
      );
  });

  it("refuses a licence with an executable bit", () => {
    expect(rules(filesCheck("suit", folder({ "LICENSE*": OFL })))).toContain("suit-stray-file");
  });

  it("gives the same verdict whole (device) and in request-sized steps (Worker)", () => {
    for (const files of [
      withLicences(),
      withLicences({ LICENSE: `${OFL}‮evil\n` }),
      withLicences({ "notes.txt": "hi" }),
      withLicences({ NOTICE: "x".repeat(300 * 1024) }),
    ]) {
      const input = inputOf(files);
      const whole = scanEntry(input);
      let state = startScan();
      for (;;) {
        const step = scanStep(state, input, { textBytes: 64, files: 1 });
        state = JSON.parse(JSON.stringify(step.state));
        if (step.done) break;
      }
      const stepped = finishScan(state, input);
      expect(stepped.verdict).toBe(whole.verdict);
      expect(rules(stepped.findings).toSorted()).toEqual(rules(whole.findings).toSorted());
    }
  });
});
