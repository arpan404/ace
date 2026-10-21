import { findExecutable } from "@ace/provider-kit/discovery";
import { triageInvocation } from "@ace/diagnostics/triage";
import type { TriageProvider } from "@ace/protocol";

/** Resolve only installed CLIs; no shell, installation or permission-bypass flags. */
export async function triageLaunch(
  provider: TriageProvider,
  prompt: string,
  env: NodeJS.ProcessEnv,
) {
  if (!prompt.trim() || Buffer.byteLength(prompt) > 96_000 || prompt.includes("\0"))
    throw new Error("The prompt must contain text and be at most 96 KB.");
  const invocation = triageInvocation(provider, prompt);
  const executable =
    (await findExecutable(invocation.command, env)) ??
    (provider === "cursor" ? await findExecutable("cursor-agent", env) : undefined);
  if (!executable)
    throw new Error(
      `${invocation.command} is not installed. Install its CLI and sign in, or copy the prompt.`,
    );
  return { command: executable, args: invocation.args };
}
