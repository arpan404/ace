import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harness } from "./account-management-test-support.ts";

test("two account homes discover and cache their own models; revoking one leaves the other usable", async () => {
  const f = await harness();
  try {
    const personal = await f.add();
    const work = await f.add();
    const home = (id: string) => {
      const account = f.registry.get(id);
      if (!account) throw new Error("Missing fixture account");
      return account.instance.homeDir;
    };
    await writeFile(join(home(personal.id), "fixture-model-name"), "gpt-6.1-sol");
    await writeFile(join(home(work.id), "fixture-model-name"), "gpt-6.2-sol");
    await f.flow(personal.id, "login");
    await f.flow(work.id, "login");
    const list = async (instance: string) => {
      const reply = await f.request(f.owner, {
        type: "models.list",
        requestId: f.rid(),
        options: { instance, offset: 0, limit: 100 },
      });
      if (reply.type !== "models.result" || !("models" in reply.result))
        throw new Error("Missing catalog");
      return reply.result.models.map((model) => model.id);
    };
    expect(await list(personal.id)).toEqual(["gpt-6.1-sol"]);
    expect(await list(work.id)).toEqual(["gpt-6.2-sol"]);
    const invocations = await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8");
    expect(await list(personal.id)).toEqual(["gpt-6.1-sol"]);
    expect(await list(work.id)).toEqual(["gpt-6.2-sol"]);
    expect(await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8")).toBe(invocations);
    await f.models.invalidate({ instance: personal.id });
    expect(await list(work.id)).toEqual(["gpt-6.2-sol"]);
    expect(f.models.list({ instance: personal.id }).models).toEqual([]);
    await writeFile(join(home(personal.id), "fixture-model-name"), "gpt-6-luna");
    await f.models.refresh({ instance: personal.id });
    expect(await list(personal.id)).toEqual(["gpt-6-luna"]);
    expect(await list(work.id)).toEqual(["gpt-6.2-sol"]);
  } finally {
    await f.close();
  }
});
