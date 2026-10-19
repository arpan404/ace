import { z } from "zod";
import { openAppServer, type AppServerOptions } from "./app-server.ts";

/*
 * ChatGPT sign-in through Codex's own app-server (`account/login/start`). Codex keeps every token:
 * ace sees the page to open, a device code, whether sign-in completed, and the account's email and
 * plan. Shapes follow codex-cli 0.163's schema and are read leniently.
 */

const Started = z
  .object({
    type: z.string(),
    loginId: z.string().min(1).max(256).optional(),
    authUrl: z.string().max(8192).optional(),
    verificationUrl: z.string().max(8192).optional(),
    userCode: z.string().max(64).optional(),
  })
  .passthrough();
const Completed = z
  .object({
    success: z.boolean(),
    loginId: z.string().nullish(),
    error: z.string().nullish(),
  })
  .passthrough();
const AccountRead = z
  .object({
    account: z
      .object({
        type: z.string(),
        email: z.string().max(320).nullish(),
        planType: z.string().max(64).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type CodexLoginKind = "chatgptDeviceCode" | "chatgpt";
export interface CodexLoginAttempt {
  loginId: string;
  /** The device page (with `userCode`) or the browser authorization page. */
  url: string;
  userCode?: string;
  /** Settles when Codex reports the sign-in finished; `success: false` when it couldn't. */
  completed: Promise<{ success: boolean }>;
}
export interface CodexAccount {
  login(kind: CodexLoginKind): Promise<CodexLoginAttempt>;
  cancel(loginId: string): Promise<void>;
  /** The signed-in ChatGPT account's email and plan; nothing for an API key or no sign-in. */
  read(): Promise<{ email?: string; plan?: string } | undefined>;
  close(): Promise<void>;
}

export async function openCodexAccount(options: AppServerOptions): Promise<CodexAccount> {
  const { rpc, close } = await openAppServer(options, "codex-account");
  const waiting = new Map<string, (result: { success: boolean }) => void>();
  // A completion can arrive before `login/start` answers with its id.
  const early = new Map<string, { success: boolean }>();
  rpc.onNotification = ({ method, params }) => {
    if (method !== "account/login/completed") return;
    const parsed = Completed.safeParse(params);
    if (!parsed.success || !parsed.data.loginId) return;
    const result = { success: parsed.data.success };
    const resolve = waiting.get(parsed.data.loginId);
    if (resolve) {
      waiting.delete(parsed.data.loginId);
      resolve(result);
    } else if (early.size < 16) early.set(parsed.data.loginId, result);
  };
  return {
    async login(kind) {
      const started = Started.parse(
        await rpc.request("account/login/start", { type: kind }, { signal: options.signal }),
      );
      const url = kind === "chatgptDeviceCode" ? started.verificationUrl : started.authUrl;
      if (started.type !== kind || !started.loginId || !url)
        throw new Error("Codex did not start this sign-in");
      const loginId = started.loginId;
      const completed = new Promise<{ success: boolean }>((resolve) => {
        const known = early.get(loginId);
        if (known) {
          early.delete(loginId);
          resolve(known);
        } else waiting.set(loginId, resolve);
      });
      return {
        loginId,
        url,
        ...(started.userCode ? { userCode: started.userCode } : {}),
        completed,
      };
    },
    async cancel(loginId) {
      waiting.delete(loginId);
      await rpc.request("account/login/cancel", { loginId }, { signal: options.signal });
    },
    async read() {
      const account = AccountRead.parse(
        await rpc.request("account/read", { refreshToken: false }, { signal: options.signal }),
      ).account;
      if (account?.type !== "chatgpt") return undefined;
      return {
        ...(account.email ? { email: account.email } : {}),
        ...(account.planType ? { plan: account.planType } : {}),
      };
    },
    close,
  };
}
