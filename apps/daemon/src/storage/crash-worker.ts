import { z } from "zod";
import { storageFixture } from "./test-support.ts";
const [root, planId, revision] = z
  .tuple([z.string().min(1), z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)])
  .parse(process.argv.slice(2));
const fixture = await storageFixture(root, async () => {
  process.exit(86);
});
await fixture.storage.apply("owner", planId, revision, true);
await fixture.close();
