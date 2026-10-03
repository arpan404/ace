// Synthetic account boundary; never starts a provider or sends inference.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
const Message = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
if (!process.argv.includes("--approved-artifact"))
  throw new Error("Lost immutable launch arguments");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = Message.parse(JSON.parse(line));
  let result: unknown = {};
  if (message.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  else if (message.method === "session/new")
    result = {
      sessionId: "synthetic",
      configOptions: [
        {
          id: "actual-model",
          category: "model",
          type: "select",
          currentValue: "one",
          options: [
            { name: "One", value: "one" },
            { name: "Two", value: "two" },
          ],
        },
      ],
    };
  else if (message.method === "session/set_config_option") {
    const selection = z
      .object({ configId: z.literal("actual-model"), value: z.literal("two") })
      .parse(message.params);
    await writeFile(
      z.string().parse(process.env.ACE_TEST_MARKER),
      JSON.stringify({ selected: selection.value, home: process.env.HOME }),
    );
  } else throw new Error("Unexpected synthetic request");
  process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
});
