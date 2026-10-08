import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { MAX_DOCUMENT_BYTES } from "./index.ts";
import { fixture } from "./test-support.ts";

test.each([
  { encoded: "é", headroom: 0 },
  { encoded: "\\u00e9", headroom: 4 },
])(
  "scalar replacements respect UTF-8 capacity with encoded model $encoded",
  async ({ encoded, headroom }) => {
    const f = await fixture();
    try {
      const prefix = `{"version":2,"settings":{"providers.coder.model":"${encoded}","threads.settleOnClose":true,"future.payload":"`;
      const suffix = '"}}';
      const payload = "x".repeat(MAX_DOCUMENT_BYTES - Buffer.byteLength(prefix + suffix));
      await writeFile(f.globalPath, prefix + payload + suffix);
      await f.service.get("threads.settleOnClose");
      await f.service.set("providers.coder.model", "x", { kind: "global" });
      await f.service.set("threads.settleOnClose", false, { kind: "global" });
      await f.service.set("providers.coder.model", "x".repeat(headroom + 1), { kind: "global" });
      const full = await readFile(f.globalPath, "utf8");
      expect(Buffer.byteLength(full)).toBe(MAX_DOCUMENT_BYTES);
      await expect(
        f.service.set("providers.coder.model", "🚀".repeat(headroom + 2), { kind: "global" }),
      ).rejects.toMatchObject({ code: "size" });
      expect(await readFile(f.globalPath, "utf8")).toBe(full);
      expect(await f.service.get("providers.coder.model")).toMatchObject({
        value: "x".repeat(headroom + 1),
      });
      expect(await f.service.get("threads.settleOnClose")).toMatchObject({ value: false });
      expect(JSON.parse(full)).toMatchObject({ settings: { "future.payload": payload } });
    } finally {
      await f.close();
    }
  },
);

test("scalar writes preserve many unknown settings and envelope fields across cached edits", async () => {
  const f = await fixture();
  try {
    const unknown = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`future.${index}`, index]),
    );
    await writeFile(
      f.globalPath,
      JSON.stringify({
        version: 2,
        futureEnvelope: "retained",
        settings: { ...unknown, "threads.settleOnClose": false },
      }),
    );
    await f.service.get("threads.settleOnClose");
    await f.service.set("threads.settleOnClose", true, { kind: "global" });
    await f.service.set("providers.coder.model", "new-model", { kind: "global" });
    await f.service.set("threads.settleOnClose", false, { kind: "global" });
    expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
      version: 2,
      futureEnvelope: "retained",
      settings: {
        ...unknown,
        "threads.settleOnClose": false,
        "providers.coder.model": "new-model",
      },
    });
  } finally {
    await f.close();
  }
});
