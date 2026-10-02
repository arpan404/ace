import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeOwnershipCase } from "./index.ts";
import { fixture } from "./review-test-support.ts";
import { plan } from "./test-support.ts";

it.each([
  ["Σ.ts", "ς.ts"],
  ["ſ.ts", "s.ts"],
  ["é.ts", "e\u0301.ts"],
])(
  "Unicode ownership aliases %s / %s cannot dispatch independent workers",
  async (first, second) => {
    const context = fixture();
    try {
      await writeFile(join(context.directory, first), "first");
      await writeFile(join(context.directory, second), "second");
      const [a, b] = await Promise.all([
        stat(join(context.directory, first)),
        stat(join(context.directory, second)),
      ]);
      const same = a.dev === b.dev && a.ino === b.ino;
      const sensitivity = await probeOwnershipCase(context.directory);
      // On an insensitive volume these real names address the same file.
      // On Linux the default admission policy remains conservatively insensitive.
      if (sensitivity === "insensitive") expect(same).toBe(true);
      const project = plan({ a: [], b: [] });
      const [one, two] = project.workstreams;
      if (!one || !two) throw new Error("Streams missing");
      one.brief.files = [first];
      two.brief.files = [second];
      await expect(context.install(project)).rejects.toThrow("ownership");
      expect(
        [...context.fake.sessions.values()].filter((session) => session.lane.role === "worker"),
      ).toEqual([]);
    } finally {
      context.close();
    }
  },
);

it.each([
  ["Σ", "ς"],
  ["ſ", "s"],
  ["ẞ", "ß"],
])(
  "Unicode aliases %s / %s also conflict across package and descendant file ownership",
  async (first, second) => {
    const context = fixture();
    try {
      const project = plan({ a: [], b: [] });
      const [one, two] = project.workstreams;
      if (!one || !two) throw new Error("Streams missing");
      one.brief.files = [];
      one.brief.packages = [first];
      two.brief.files = [`${second}/worker.ts`];
      await expect(context.install(project)).rejects.toThrow("ownership");
      expect(
        [...context.fake.sessions.values()].filter((session) => session.lane.role === "worker"),
      ).toEqual([]);
    } finally {
      context.close();
    }
  },
);
