import { afterEach, expect, test } from "vitest";
import { PluginService } from "./index.ts";
import { fixture } from "./test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
test("accepted plugins expose projected invocation names and disabling them removes their components", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  await f.manager.accept(await f.prepare());
  const service = new PluginService(f.manager);
  expect(await service.extensions("claude")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "command",
        name: "sample:check",
        invocation: { type: "slash", name: "sample:check" },
      }),
    ]),
  );
  expect(await service.extensions("opencode")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "agent",
        invocation: { type: "agent", name: "ace-sample__reviewer" },
      }),
    ]),
  );
  const changed = new Promise<void>((resolve) => {
    const stop = service.subscribeCatalog(() => {
      stop();
      resolve();
    });
  });
  await service.handle({
    type: "plugins.availability",
    name: "sample",
    enabled: false,
    providers: ["claude", "opencode"],
  });
  await changed;
  expect(await service.extensions("claude")).toEqual([]);
  expect(await service.extensions("opencode")).toEqual([]);
});
