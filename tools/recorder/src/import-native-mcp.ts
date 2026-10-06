// Import a capped, owner-authorized native sandbox capture without starting another paid turn.
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Recording } from "./recording.ts";
import { createRedactor } from "./redact.ts";

const [input, output, provider, version, workspace, model] = z
  .tuple([
    z.string(),
    z.string(),
    z.enum(["opencode", "codex", "claude", "cursor"]),
    z.string(),
    z.string(),
    z.string().optional(),
  ])
  .parse(process.argv.slice(2));
const frames = z
  .array(
    z.object({
      dir: z.enum(["send", "recv", "note"]),
      channel: z.string(),
      data: z.unknown(),
    }),
  )
  .parse(JSON.parse(await readFile(input, "utf8")));
const scrub = createRedactor({ workspace, env: process.env });
const recording = new Recording(output, {
  format: "ace-recording/v1",
  provider,
  cliVersion: version,
  scenario: "native-ace-mcp",
  startedAt: (await stat(input)).mtime.toISOString(),
  platform: process.platform,
  workspace: "<WORKSPACE>",
  ...(model ? { model } : {}),
});
try {
  recording.note("imported-sandbox-capture", {
    timing: "Frames retain ordering; import timestamps do not measure provider latency.",
  });
  for (const frame of frames) {
    const redacted: unknown = JSON.parse(
      scrub(JSON.stringify(frame.data).replaceAll(encodeURIComponent(workspace), "<WORKSPACE>")),
    );
    recording.frame(frame.dir, frame.channel, redacted);
  }
} finally {
  await recording.close();
}
