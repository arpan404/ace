import { InstallAction, ProviderKind, type ProviderInstallPlan } from "@ace/protocol";
import {
  CliInstallController,
  providerNames,
  type InstallClient,
  type InstallView,
} from "@ace/ui-core";
import { z } from "zod";
import { scheduler } from "./host.ts";
import { preview } from "./presentation.ts";

/*
 * Installing, updating or removing a provider's CLI on the computer, from its page. The shared
 * controller (`@ace/ui-core`, the web's too) owns the job: the plan first, then the run, its
 * progress pushed by the daemon and polled again after a reconnect. One flow per provider lives
 * as long as this runtime, so leaving the page and coming back shows the same job. Swift waits
 * for the next change with `provider.install.watch` and acts with `provider.install.act`.
 */

export const ProviderInstallWatch = z.object({
  type: z.literal("provider.install.watch"),
  provider: ProviderKind,
  /** The last revision Swift drew; the answer waits for a newer one, up to `waitMs`. */
  after: z.number().int().min(-1),
});
export const ProviderInstallAct = z.object({
  type: z.literal("provider.install.act"),
  provider: ProviderKind,
  step: z.discriminatedUnion("kind", [
    /** Show what would run, before anything runs. */
    z.object({ kind: z.literal("plan"), action: InstallAction }),
    /** Run the plan shown. */
    z.object({ kind: z.literal("run") }),
    z.object({ kind: z.literal("cancel") }),
    /** Put a finished or refused job away. */
    z.object({ kind: z.literal("dismiss") }),
  ]),
});

export interface InstallFact {
  term: string;
  value: string;
}
export interface InstallScreen {
  revision: number;
  /** Nothing is happening: the page shows its own Install or Update. */
  idle: boolean;
  title: string;
  status: { label: string; token: "working" | "done" | "failed" | "needsYou" | "neutral" } | null;
  busy: boolean;
  /** What will run and where, before it runs. */
  facts: InstallFact[];
  /** The commands the plan runs, or the job's redacted log once it runs. */
  lines: string[];
  message: string | null;
  /** The button that runs the plan, or null when there is nothing to run from here. */
  confirm: { label: string; destructive: boolean } | null;
  cancel: boolean;
  retry: { action: InstallAction } | null;
  /** The official installer or a missing prerequisite's download. */
  link: { label: string; url: string } | null;
  finished: boolean;
  /** The job finished and changed what is installed: the page reads its provider again. */
  changed: boolean;
}

const actionWords: Record<InstallAction, { title: string; confirm: string; running: string }> = {
  install: { title: "Install", confirm: "Install", running: "Installing…" },
  update: { title: "Update", confirm: "Update", running: "Updating…" },
  uninstall: { title: "Remove", confirm: "Remove CLI", running: "Removing…" },
};
const failedWords: Record<InstallAction, string> = {
  install: "Install failed",
  update: "Update failed",
  uninstall: "Removal failed",
};
const methodNames: Record<NonNullable<ProviderInstallPlan["method"]>, string> = {
  npm: "npm",
  bun: "Bun",
  brew: "Homebrew",
  script: "Official install script",
  registry: "ACP registry",
};

/** What the install area of a provider's page shows for the controller's `view`. */
export function installScreen(
  view: InstallView,
  provider: ProviderKind,
  machine: string,
  revision: number,
  wanted: InstallAction,
): InstallScreen {
  const name = providerNames[provider];
  const base: InstallScreen = {
    revision,
    idle: false,
    title: `${actionWords[wanted].title} ${name}`,
    status: null,
    busy: false,
    facts: [],
    lines: [],
    message: null,
    confirm: null,
    cancel: false,
    retry: null,
    link: null,
    finished: false,
    changed: false,
  };
  switch (view.kind) {
    case "idle":
      return { ...base, idle: true };
    case "loading":
      return {
        ...base,
        status: { label: "Preparing…", token: "working" },
        busy: true,
        cancel: true,
      };
    case "error":
      return {
        ...base,
        status: { label: failedWords[wanted], token: "failed" },
        message: preview(view.message, 512),
        retry: { action: wanted },
        finished: true,
      };
    case "plan":
      return planScreen(base, view.plan, name, machine);
    case "progress": {
      const { progress } = view;
      const words = actionWords[progress.action];
      const running = ["planning", "running", "verifying"].includes(progress.state);
      const plan = progress.plan;
      const lines = progress.lines.slice(-100).map((line) => preview(line, 2048));
      const screen = {
        ...base,
        title: `${words.title} ${name}`,
        lines,
        facts: plan ? planFacts(plan, machine) : [],
        busy: running,
        cancel: running,
        link: plan ? { label: "Official installer", url: plan.sourceUrl } : null,
      };
      if (running)
        return {
          ...screen,
          status: {
            label:
              progress.state === "verifying"
                ? "Checking…"
                : progress.state === "planning"
                  ? "Preparing…"
                  : words.running,
            token: "working",
          },
        };
      if (progress.state === "succeeded")
        return {
          ...screen,
          status: {
            label: progress.action === "uninstall" ? "Removed" : "Installed",
            token: "done",
          },
          message: progress.version
            ? `${name} ${preview(progress.version, 64)} is ready on ${machine}.`
            : progress.message
              ? preview(progress.message, 512)
              : null,
          finished: true,
          changed: true,
        };
      if (progress.state === "cancelled")
        return {
          ...screen,
          status: { label: "Cancelled", token: "neutral" },
          retry: { action: progress.action },
          finished: true,
          changed: true,
        };
      if (progress.state === "needs_admin")
        return {
          ...screen,
          status: { label: "Approval needed", token: "needsYou" },
          message: `This installer needs administrator approval. Run it in a terminal on ${machine}.`,
          finished: true,
        };
      return {
        ...screen,
        status: { label: failedWords[progress.action], token: "failed" },
        message: progress.message
          ? preview(progress.message, 512)
          : "The installer couldn't finish. Retry, or check the log.",
        retry: { action: progress.action },
        finished: true,
      };
    }
  }
}

function planFacts(plan: ProviderInstallPlan, machine: string): InstallFact[] {
  const facts: InstallFact[] = [{ term: "Runs on", value: preview(machine, 128) }];
  if (plan.method) facts.push({ term: "Using", value: methodNames[plan.method] });
  if (plan.installedVersion && plan.action !== "install")
    facts.push({ term: "Installed", value: preview(plan.installedVersion, 64) });
  if (plan.latestVersion && plan.action !== "uninstall")
    facts.push({ term: "Latest", value: preview(plan.latestVersion, 64) });
  if (plan.needsAdmin) facts.push({ term: "Needs", value: "Administrator approval" });
  return facts;
}

function planScreen(
  base: InstallScreen,
  plan: ProviderInstallPlan,
  name: string,
  machine: string,
): InstallScreen {
  const words = actionWords[plan.action];
  const screen: InstallScreen = {
    ...base,
    title: `${words.title} ${name}`,
    facts: planFacts(plan, machine),
    lines: plan.commands.map((command) => preview(command.display, 2048)),
    link: { label: "Official installer", url: plan.sourceUrl },
    cancel: true,
  };
  const runnable = plan.status === "ready" && !plan.needsAdmin && !!plan.method;
  if (runnable)
    return {
      ...screen,
      message:
        plan.action === "uninstall"
          ? `Remove ${name}'s CLI from ${machine}? Sign-ins and conversations stay saved.`
          : plan.message
            ? preview(plan.message, 512)
            : null,
      confirm: { label: words.confirm, destructive: plan.action === "uninstall" },
    };
  if (plan.needsAdmin)
    return {
      ...screen,
      status: { label: "Approval needed", token: "needsYou" },
      message: `This installer needs administrator approval. Run the command in a terminal on ${machine}.`,
    };
  if (plan.prerequisite)
    return {
      ...screen,
      status: { label: "Needs a prerequisite", token: "needsYou" },
      message: plan.message
        ? preview(plan.message, 512)
        : `Install ${plan.prerequisite.name} first.`,
      link: {
        label: `Get ${preview(plan.prerequisite.name, 64)}`,
        url: plan.prerequisite.sourceUrl,
      },
      retry: { action: plan.action },
    };
  if (plan.status === "sign_in")
    return {
      ...screen,
      lines: [],
      message: plan.message ? preview(plan.message, 512) : `Sign in to ${name}.`,
    };
  return {
    ...screen,
    message: plan.message
      ? preview(plan.message, 512)
      : "Follow the provider's official installation instructions.",
    link: {
      label: plan.downloadOnly ? `Get ${name}` : "Official installer",
      url: plan.sourceUrl,
    },
  };
}

interface Flow {
  controller: CliInstallController;
  revision: number;
  wanted: InstallAction;
  waiters: Set<() => void>;
}

export class ProviderInstalls {
  readonly #owner: InstallClient;
  readonly #machine: () => Promise<string>;
  readonly #waitMs: number;
  #flows = new Map<ProviderKind, Flow>();
  constructor(owner: InstallClient, machine: () => Promise<string>, waitMs = 20_000) {
    this.#owner = owner;
    this.#machine = machine;
    this.#waitMs = waitMs;
  }

  /** The install area now, or as soon as it is newer than `after`. */
  async watch(
    request: z.infer<typeof ProviderInstallWatch>,
    signal?: AbortSignal,
  ): Promise<InstallScreen> {
    const flow = this.#flow(request.provider);
    if (flow.revision <= request.after)
      await new Promise<void>((resolve) => {
        const done = () => {
          stop();
          flow.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const stop = scheduler.set(this.#waitMs, done);
        flow.waiters.add(done);
        signal?.addEventListener("abort", done);
      });
    return this.#screen(request.provider, flow);
  }

  async act(request: z.infer<typeof ProviderInstallAct>): Promise<InstallScreen> {
    const flow = this.#flow(request.provider);
    const { controller } = flow;
    const step = request.step;
    if (step.kind === "plan") {
      flow.wanted = step.action;
      await controller.plan(step.action);
    } else if (step.kind === "run") {
      const view = controller.getView();
      if (view.kind === "plan" && view.plan.method)
        await controller.run(view.plan.action, view.plan.method);
    } else if (step.kind === "cancel") await controller.cancel();
    else controller.close();
    return this.#screen(request.provider, flow);
  }

  dispose(): void {
    for (const flow of this.#flows.values()) flow.controller.dispose();
    this.#flows.clear();
  }

  async #screen(provider: ProviderKind, flow: Flow): Promise<InstallScreen> {
    const machine = await this.#machine();
    return installScreen(flow.controller.getView(), provider, machine, flow.revision, flow.wanted);
  }

  #flow(provider: ProviderKind): Flow {
    const existing = this.#flows.get(provider);
    if (existing) return existing;
    const controller = new CliInstallController(this.#owner, { provider }, { remember: () => {} });
    const flow: Flow = { controller, revision: 0, wanted: "install", waiters: new Set() };
    controller.subscribe(() => {
      flow.revision++;
      for (const wake of [...flow.waiters]) wake();
    });
    controller.start();
    this.#flows.set(provider, flow);
    return flow;
  }
}
