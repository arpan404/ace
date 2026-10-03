import { spawnInteractive } from "@ace/provider-kit/process";
import { ProviderInstance } from "@ace/protocol/accounts";
import { AcpIdentity } from "@ace/protocol";
import { z } from "zod";
import { instanceEnv } from "./instances.ts";
import type { AccountRegistry } from "./registry.ts";
export const AcpLoginPlan = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64),
  env: z
    .record(z.string().max(256), z.string().max(32768).optional())
    .refine((env) => Object.keys(env).length <= 512),
});
export type AcpLoginPlan = z.infer<typeof AcpLoginPlan>;
export type AcpLoginResolver = (
  identity: AcpIdentity,
  env: NodeJS.ProcessEnv,
) => Promise<AcpLoginPlan | undefined>;
/** Local terminal only. The resolver selects an approved CLI; no auth bytes are captured. */
export async function loginAcpAccount(
  registry: AccountRegistry,
  input: ProviderInstance,
  options: {
    env: NodeJS.ProcessEnv;
    resolve: AcpLoginResolver;
    signal?: AbortSignal;
    spawn?: typeof spawnInteractive;
  },
): Promise<
  { status: "unsupported"; reason: string } | { status: "completed"; code: number | null }
> {
  const instance = ProviderInstance.parse(input);
  const stored = registry.get(instance.id)?.instance;
  if (
    instance.provider !== "acp" ||
    !stored ||
    stored.acpAgentId !== instance.acpAgentId ||
    stored.installationId !== instance.installationId
  )
    throw new Error("Unregistered ACP account identity");
  options.signal?.throwIfAborted();
  const plan = await options.resolve(AcpIdentity.parse(stored), instanceEnv(stored, options.env));
  if (!plan)
    return {
      status: "unsupported",
      reason: "No reviewed local login command for this ACP profile",
    };
  const parsed = AcpLoginPlan.parse(plan);
  options.signal?.throwIfAborted();
  const child = (options.spawn ?? spawnInteractive)(parsed);
  const cancel = () => {
    void child.stop();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const exit = await child.exited;
    options.signal?.throwIfAborted();
    if (exit.reason === "spawn-error") throw new Error("Login CLI failed to start");
    if (exit.code === 0) registry.loginChanged(instance.id);
    return { status: "completed", code: exit.code };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
