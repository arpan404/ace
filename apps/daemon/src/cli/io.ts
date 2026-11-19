import { spawn } from "node:child_process";
import { option, type Args } from "./args.ts";
import { formatOutput, CliFailure, type Outcome, exitCodes, usageFailure } from "./output.ts";
import { outputMode } from "./input-mode.ts";
import { humanize, identifiers } from "./render/generic.ts";

/** How a value reads for a person and for `--quiet`; without one, the generic words. */
export interface Renderer<T> {
  readonly human?: (value: T) => string | readonly string[];
  readonly quiet?: (value: T) => readonly string[];
}
/** Compile the filter without evaluating it against placeholder data, before any effects. */
export async function validateOutput(args: Args): Promise<void> {
  const filter = option(args, "jq");
  if (filter === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("jq", ["-n", `if false then (\n${filter}\n) else null end`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString()).slice(-4096);
    });
    child.once("error", () =>
      reject(new CliFailure("refused", "--jq requires the installed jq executable")),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            usageFailure(`--jq: ${diagnostic.trim() || "the filter isn't valid"}`, {
              argument: "--jq",
            }),
          ),
    );
  });
}
/** Prints one command's result in the mode asked for (ADR 0178 §3). */
export async function emit<T>(args: Args, value: T, render: Renderer<T> = {}): Promise<void> {
  const mode = outputMode(args.flags);
  if (mode === "json") return print(args, value);
  if (mode === "quiet") {
    const ids = render.quiet ? render.quiet(value) : identifiers(value);
    return write(ids.length ? `${ids.join("\n")}\n` : "");
  }
  const human = render.human ? render.human(value) : undefined;
  const lines =
    human === undefined ? humanLines(value) : typeof human === "string" ? [human] : human;
  return write(lines.length ? `${lines.join("\n")}\n` : "");
}

function humanLines(value: unknown): readonly string[] {
  return typeof value === "string" ? [value] : humanize(value);
}

function write(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

export async function print(args: Args, value: unknown): Promise<void> {
  const jq = option(args, "jq");
  const json = !!args.flags.json || !!jq || args.flags.stream === "jsonl";
  // A person never reads indented JSON; quiet mode reads identifiers.
  if (!json) return emit(args, value);
  const text = formatOutput(value, json);
  if (!jq) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("jq", [jq], { stdio: ["pipe", "inherit", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString()).slice(-4096);
    });
    child.once("error", () =>
      reject(new CliFailure("refused", "--jq requires the installed jq executable")),
    );
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new CliFailure("refused", diagnostic || "jq failed")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
export async function result(args: Args, value: unknown, outcome: Outcome = "ok"): Promise<void> {
  await print(args, value);
  process.exitCode = exitCodes[outcome];
}
export async function mutationResult(
  args: Args,
  value: unknown,
  outcome: Outcome = "ok",
): Promise<void> {
  try {
    await result(args, value, outcome);
  } catch {
    throw new CliFailure(
      "uncertain",
      "Work was admitted, but output failed. Retry with the same idempotency key.",
      value,
    );
  }
}
/**
 * The text at `index`, or stdin when it is `-`. Stdin is never read by default, so an agent
 * whose stdin is an open pipe never waits on it (ADR 0178 §9).
 */
export async function prompt(args: Args, index: number): Promise<string> {
  const supplied = args.words[index];
  if (supplied !== undefined && supplied !== "-") return supplied;
  if (supplied === undefined && args.interactive) {
    const { askText } = await import("./ask.ts");
    return askText("What should the agent do?", "Pass it as an argument, or - to read stdin.");
  }
  if (supplied === undefined)
    throw usageFailure("This needs the text to send.", {
      code: "missing_argument",
      hint: "Pass it as an argument, or - to read it from stdin.",
    });
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 1_048_576) throw usageFailure("The text on stdin is over 1 MiB.");
  }
  if (!text.trim()) throw usageFailure("The text on stdin is empty.", { code: "missing_argument" });
  return text;
}
