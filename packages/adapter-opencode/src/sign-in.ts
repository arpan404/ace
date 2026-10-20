import { z } from "zod";
import { spawnSupervised } from "@ace/provider-kit/process";
import { randomBytes } from "node:crypto";
import { basicAuthorization, ownedServerReady, spawnOwnedServer } from "./owned-server.ts";

/*
 * OpenCode v2 signs in through its own server: integrations list their methods, and an OAuth
 * method starts an attempt that returns the page to open and a code, then reports when the person
 * finished. ace reads only method descriptions and attempt status, never a credential.
 */

const FormOption = z.object({ value: z.string(), label: z.string() }).passthrough();
const FormField = z
  .object({
    key: z.string(),
    type: z.string(),
    required: z.boolean().optional(),
    hidden: z.boolean().optional(),
    default: z.unknown().optional(),
    title: z.string().optional(),
    options: z.array(FormOption).optional(),
    when: z
      .array(z.object({ key: z.string(), op: z.string(), value: z.unknown() }).passthrough())
      .optional(),
  })
  .passthrough();
export type OpenCodeFormField = z.infer<typeof FormField>;
const Method = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    label: z.string().optional(),
    form: z.array(FormField).nullish().catch(undefined),
  })
  .passthrough();
const Integration = z
  .object({ id: z.string(), name: z.string(), methods: z.array(Method).catch([]) })
  .passthrough();
export type OpenCodeIntegration = z.infer<typeof Integration>;
const Attempt = z
  .object({
    attemptID: z.string().min(1).max(256),
    url: z.string().max(8192).catch(""),
    instructions: z.string().max(2048).catch(""),
    mode: z.string(),
  })
  .passthrough();
export type OpenCodeAttempt = z.infer<typeof Attempt>;
const Status = z.object({ status: z.string() }).passthrough();

export interface OpenCodeSignIn {
  integrations(): Promise<OpenCodeIntegration[]>;
  begin(
    integration: string,
    method: string,
    answer: Record<string, string>,
  ): Promise<OpenCodeAttempt>;
  /** `pending`, `complete`, `failed`, or anything newer OpenCode reports. */
  status(integration: string, attempt: string): Promise<string>;
  cancel(integration: string, attempt: string): Promise<void>;
  close(): Promise<void>;
}

const integrationPath = (id: string) => `/api/integration/${encodeURIComponent(id)}`;

/** Starts a private OpenCode server for one sign-in. Close it when the sign-in ends. */
export async function openOpenCodeSignIn(options: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  spawn?: typeof spawnSupervised;
  fetch?: typeof fetch;
  entropy?: () => string;
  /** A server that hasn't announced itself by then is given up on; the terminal takes over. */
  startupTimeoutMs?: number;
}): Promise<OpenCodeSignIn> {
  const password = options.entropy?.() ?? randomBytes(32).toString("hex");
  const authorization = basicAuthorization(password);
  const proc = spawnOwnedServer({
    spawn: options.spawn ?? spawnSupervised,
    command: options.command,
    env: options.env,
    password,
    cwd: options.cwd,
  });
  const stopped = new AbortController();
  void proc.exited.then(() => stopped.abort());
  const close = async () => {
    await proc.stop({ graceMs: 1000 });
  };
  let base: URL;
  try {
    base = await ownedServerReady(
      proc,
      AbortSignal.any([
        options.signal,
        stopped.signal,
        AbortSignal.timeout(options.startupTimeoutMs ?? 15_000),
      ]),
    );
  } catch (error) {
    await close();
    throw error;
  }
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await (options.fetch ?? fetch)(new URL(path, base), {
      ...init,
      headers: { authorization, "content-type": "application/json" },
      signal: AbortSignal.any([options.signal, stopped.signal]),
    });
    if (!response.ok) throw new Error(`OpenCode sign-in request failed (${response.status})`);
    return response.status === 204
      ? undefined
      : z.object({ data: z.unknown() }).parse(await response.json()).data;
  };
  return {
    async integrations() {
      return z
        .array(z.unknown())
        .max(1024)
        .parse(await request("/api/integration"))
        .flatMap((entry) => {
          const parsed = Integration.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
    },
    async begin(integration, method, answer) {
      return Attempt.parse(
        await request(`${integrationPath(integration)}/connect/oauth`, {
          method: "POST",
          body: JSON.stringify({
            methodID: method,
            ...(Object.keys(answer).length ? { answer } : {}),
          }),
        }),
      );
    },
    async status(integration, attempt) {
      return Status.parse(
        await request(
          `${integrationPath(integration)}/connect/oauth/${encodeURIComponent(attempt)}`,
        ),
      ).status;
    },
    async cancel(integration, attempt) {
      await request(
        `${integrationPath(integration)}/connect/oauth/${encodeURIComponent(attempt)}`,
        {
          method: "DELETE",
        },
      );
    },
    close,
  };
}
