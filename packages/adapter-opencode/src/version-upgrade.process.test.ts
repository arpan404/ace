import { expect, test } from "vitest";
import { discoverOpenCodeModels } from "./index.ts";
import { setup } from "./testing/v2-session.ts";

test("the reviewed OpenCode 2.0.26 patch can list models with matching server identity and API contract", async () => {
  const h = await setup({
    discovery: {
      env: {
        ACE_TEST_OPENCODE_VERSION: "2.0.26",
        ACE_TEST_SERVER_VERSION: "2.0.26",
      },
    },
  });
  const report = await discoverOpenCodeModels(h.options, "/one", new AbortController().signal);
  expect(report).toMatchObject({ location: { directory: "/one" }, data: expect.any(Array) });
});
