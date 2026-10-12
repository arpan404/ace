import { z } from "zod";
import { storageFixture } from "./test-support.ts";

const args = process.argv.slice(2);
if (args[1] === "compact") {
  // Killed without exit handlers right after the first durable compaction step.
  const [root] = z.tuple([z.string().min(1), z.literal("compact")]).parse(args);
  const fixture = await storageFixture(root, undefined, {
    limits: { chunkPages: 8 },
    afterCompactionStep: async () => {
      process.kill(process.pid, "SIGKILL");
    },
  });
  await fixture.storage.compact("owner");
  await fixture.close();
} else {
  const [root, planId, revision] = z
    .tuple([z.string().min(1), z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)])
    .parse(args);
  const fixture = await storageFixture(root, async () => {
    process.exit(86);
  });
  await fixture.storage.apply("owner", planId, revision);
  await fixture.close();
}
