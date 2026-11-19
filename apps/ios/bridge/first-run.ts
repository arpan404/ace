import type { ClientCore } from "@ace/client";
import type { OnboardingResult, ProviderKind, ProviderStatus } from "@ace/protocol";
import { providerNames, readinessView } from "@ace/ui-core";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * The phone's first run on a computer, as web's `/setup` first step: the agents the computer
 * has, each ready or with the one step that readies it. The daemon keeps whether this phone has
 * finished or skipped it (`onboarding.query` / `onboarding.dismiss`, per device), so a second
 * phone still sees it and Settings can open it again.
 */

export const FirstRunRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setup.read") }),
  z.object({ type: z.literal("setup.dismiss"), dismissed: z.boolean() }),
]);
export type FirstRunRequest = z.infer<typeof FirstRunRequest>;

/** The page the row opens: sign in, install or update the CLI, or its provider page. */
export type FirstRunStep = "sign_in" | "install" | "update" | "open";

export interface FirstRunRow {
  provider: ProviderKind;
  name: string;
  status: { label: string; token: "done" | "needsYou" | "failed" | "neutral" };
  detail: string | null;
  ready: boolean;
  step: FirstRunStep | null;
  /** The one row worth doing first, highlighted while nothing is ready. */
  next: boolean;
}

export interface FirstRunScreen {
  /** Shown after pairing: nothing is ready and this phone hasn't finished or skipped it. */
  offer: boolean;
  dismissed: boolean;
  ready: number;
  /** Installed agents, ready or not. */
  installed: FirstRunRow[];
  /** Agents ace can install on the computer. */
  missing: FirstRunRow[];
  progress: string;
}

type Onboarding = Extract<OnboardingResult["result"], { ok: true }>;
const tokens = { ready: "done", action: "needsYou", problem: "failed", idle: "neutral" } as const;

function row(status: ProviderStatus, ready: boolean, next: boolean): FirstRunRow {
  const name = providerNames[status.provider];
  const view = readinessView(status);
  const missing = view.state === "not_installed";
  // Phones read no model catalog: a CLI that doesn't say who is signed in is ready when the
  // daemon counts it so, else it reads as installed rather than "Checking…" forever.
  const label = ready ? "Ready" : view.state === "checking" ? "Installed" : view.label;
  const step: FirstRunStep | null = ready
    ? null
    : missing
      ? status.provider === "cursor"
        ? null
        : "install"
      : view.primary === "sign_in" || view.primary === "reconnect"
        ? "sign_in"
        : view.primary === "update"
          ? "update"
          : "open";
  return {
    provider: status.provider,
    name,
    status: { label, token: ready ? "done" : tokens[view.tone] },
    detail: !ready && view.detail ? preview(view.detail, 512) : null,
    ready,
    step,
    next,
  };
}

const missingRow = (status: ProviderStatus) => readinessView(status).state === "not_installed";

/** The first-run page from the daemon's checklist. ACP agents are added from Settings. */
export function firstRunScreen(onboarding: Onboarding): FirstRunScreen {
  const ready = new Set(onboarding.ready);
  const rows = onboarding.providers.filter((status) => status.provider !== "acp");
  const isReady = (status: ProviderStatus) =>
    ready.has(status.provider) || readinessView(status).ready;
  const readyCount = rows.filter(isReady).length;
  const suggested = readyCount === 0 ? onboarding.next.provider : undefined;
  const installed = rows
    .filter((status) => !missingRow(status))
    .map((status) => row(status, isReady(status), status.provider === suggested));
  // With nothing installed the daemon suggests an install; it marks that row instead.
  const missing = rows
    .filter(missingRow)
    .map((status) => row(status, false, status.provider === suggested));
  return {
    offer: !onboarding.dismissed && readyCount === 0,
    dismissed: onboarding.dismissed,
    ready: readyCount,
    installed,
    missing,
    progress: `${readyCount} of ${installed.length} ready`,
  };
}

type Owner = Pick<ClientCore, "request">;
export type FirstRunReply = { ok: true; screen: FirstRunScreen } | { ok: false; message: string };

const refused = {
  forbidden: "This computer doesn't share its coding agents with this phone.",
  unavailable: "This version of ace can't list its agents for setup. Check Settings › Providers.",
} as const;

/** Reads the page, or records this phone's Skip or Done and answers the page after it. */
export async function answerFirstRun(
  owner: Owner,
  request: FirstRunRequest,
  signal: AbortSignal,
): Promise<FirstRunReply> {
  const options = { signal, timeoutMs: 15_000 };
  const reply =
    request.type === "setup.dismiss"
      ? await owner.request({ type: "onboarding.dismiss", dismissed: request.dismissed }, options)
      : await owner.request({ type: "onboarding.query" }, options);
  if (!reply.result.ok) return { ok: false, message: refused[reply.result.error] };
  return { ok: true, screen: firstRunScreen(reply.result) };
}
