import { teaIdentity, teaLogin, type CommandRunner } from "@ace/forge";

/** A pinned tea login name is not a hostname. Resolve it before constructing admission rules. */
export async function teaSourceIdentity(runner: CommandRunner, host: string, signal: AbortSignal) {
  const login = await teaLogin(runner, host, signal);
  return { login, identify: (probe: AbortSignal) => teaIdentity(runner, host, login, probe) };
}
