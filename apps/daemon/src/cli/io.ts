import { spawn } from "node:child_process";
import { option, type Args } from "./args.ts";
import { formatOutput, CliFailure, type Outcome, exitCodes } from "./output.ts";
export async function print(args: Args, value: unknown): Promise<void> {
  const jq = option(args, "jq");
  const text = formatOutput(value, !!args.flags.json || !!jq || args.flags.stream === "jsonl");
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
export async function prompt(args: Args, index: number): Promise<string> {
  const supplied = args.words[index];
  if (supplied !== undefined && supplied !== "-") return supplied;
  if (process.stdin.isTTY) throw new CliFailure("refused", "Supply a prompt or pipe it on stdin");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 1_048_576)
      throw new CliFailure("refused", "Prompt exceeds 1 MiB");
  }
  if (!text.trim()) throw new CliFailure("refused", "Prompt is empty");
  return text;
}
