import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { parseRecording, turnFrames, type Recording } from "./replay.ts";
import type { FakeSettings } from "./settings.ts";

const Input = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  request_id: z.string().optional(),
  request: z.looseObject({ subtype: z.string().optional() }).optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});
type Input = z.infer<typeof Input>;

/** A small model menu in the shape the CLI reports, so model discovery succeeds. */
const models = [
  {
    value: "default",
    displayName: "Default",
    resolvedModel: "bench-large",
    supportedEffortLevels: ["low", "medium", "high"],
  },
  { value: "small", displayName: "Small", resolvedModel: "bench-small", supportedEffortLevels: [] },
];

/** Directives in the user's text pick the scenario per turn: `fixture=NAME text-deltas=N`. */
export function directives(text: string) {
  const fixture = /\bfixture=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const deltas = /\btext-deltas=(\d+)/.exec(text)?.[1];
  return { fixture, textDeltas: deltas === undefined ? undefined : Number(deltas) };
}
function inputText(message: Input["message"]): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      const parsed = z.looseObject({ text: z.string() }).safeParse(part);
      return parsed.success ? parsed.data.text : "";
    })
    .join("\n");
}
function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

const write = (frame: unknown) =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(frame)}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );

/** Claude's stream-json CLI: probes, control requests and one replayed recording per user turn. */
export async function runClaude(args: readonly string[], settings: FakeSettings): Promise<number> {
  const recordings = new Map<string, Recording>();
  const recording = (name: string) => {
    let value = recordings.get(name);
    if (!value) {
      value = parseRecording(readFileSync(join(settings.fixtures, `${name}.jsonl`), "utf8"));
      recordings.set(name, value);
    }
    return value;
  };
  if (args.includes("--version") || args[0] === "-v") {
    process.stdout.write(`${recording(settings.fixture).cliVersion} (Claude Code)\n`);
    return 0;
  }
  if (args[0] === "auth") {
    process.stdout.write(
      `${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "bench@example.invalid" })}\n`,
    );
    return 0;
  }
  if (
    args.includes("--help") ||
    ["help", "mcp", "doctor", "plugin", "config"].includes(args[0] ?? "")
  ) {
    // One-shot commands the daemon may probe: answer and leave.
    process.stdout.write("fake claude\n");
    return 0;
  }
  const sessionId = flag(args, "--resume") ?? flag(args, "--session-id") ?? randomUUID();
  let turn = 0;
  let queue = Promise.resolve();
  const replay = async (input: Input) => {
    const chosen = directives(inputText(input.message));
    const frames = turnFrames(recording(chosen.fixture ?? settings.fixture), {
      turn: ++turn,
      sessionId,
      inputId: input.uuid,
      workspace: process.cwd(),
      newId: randomUUID,
      speed: settings.speed,
      extraTextDeltas: chosen.textDeltas ?? 0,
      extraDeltaMs: settings.deltaMs,
    });
    for (const { delayMs, frame } of frames) {
      if (delayMs >= 1) await pause(delayMs);
      await write(frame);
    }
  };
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let parsed: Input;
    try {
      parsed = Input.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.type === "control_request") {
      const subtype = parsed.request?.subtype;
      const response =
        subtype === "initialize"
          ? {
              commands: [],
              models,
              account: { email: "bench@example.invalid" },
              output_style: "default",
              available_output_styles: ["default"],
            }
          : {};
      await write({
        type: "control_response",
        response: { subtype: "success", request_id: parsed.request_id, response },
      });
    } else if (parsed.type === "user") {
      const input = parsed;
      queue = queue.then(() => replay(input));
    }
  }
  await queue;
  return 0;
}
