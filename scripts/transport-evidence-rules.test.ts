// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { caseEvidence, type EvidenceLine } from "./transport-evidence.ts";

const title =
  "a LAN port taken at start is reported, and once freed the listener serves on the next retry";

it("credits retry traffic only from the listener that bound after the refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-transport-evidence-"));
  const evidence = join(dir, "evidence.jsonl");
  const listener = { listener: "remote", pid: 100, port: 50281 };
  const bound = { ...listener, instance: 2 };
  const close = { ...bound, event: "close" };
  const traffic = { connections: 1, exchanges: 1 };
  const verdict = (...lines: EvidenceLine[]) => {
    writeFileSync(
      evidence,
      [
        { event: "case", name: title, id: "retry" },
        { ...listener, event: "bind-failed", code: "EADDRINUSE" },
        { ...bound, event: "bind" },
        ...lines,
        { event: "case-end", id: "retry" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    return caseEvidence("native-remote.process.test.ts", evidence, [{ fullName: title, title }])
      .cases[0]?.verdict;
  };

  try {
    expect(verdict({ ...close, ...traffic })).toBe("proven");
    expect(verdict({ ...close, connections: 1, upgrades: 1 })).toBe("proven");
    expect(verdict({ ...bound, ...traffic, event: "handled" }, close)).toBe("proven");
    expect(verdict({ ...close, exchanges: 1 })).toBe("NONE");
    expect(verdict({ ...close, connections: 1 })).toBe("NONE");
    expect(verdict({ ...close, ...traffic, pid: 200 }, close)).toBe("NONE");
    expect(verdict({ ...close, ...traffic, instance: 1 }, close)).toBe("NONE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
