import { readJson, writeJson } from "@ace/ui-core";
import { z } from "zod";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { acpRegistryId } from "@ace/ui-core/provider-icons";
import { useClient } from "@ace/client-react";
import { InstallAgent, type InstallAction, type ProviderInstallProgress } from "@ace/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { CopyCommand } from "@/components/copy-command.tsx";
import { Button } from "@/components/ui/button.tsx";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { SignInButton } from "@/features/sign-in/index.ts";
import type { ProviderInstall } from "./data/backend.ts";
import { CliInstallController } from "./cli-install-controller.ts";

const actionNames: Record<InstallAction, string> = {
  install: "Install CLI",
  update: "Update CLI",
  uninstall: "Remove CLI",
};
const progressNames: Record<ProviderInstallProgress["state"], string> = {
  planning: "Preparing…",
  running: "Installing…",
  verifying: "Checking installation…",
  succeeded: "Finished",
  failed: "Installation failed",
  cancelled: "Cancelled",
  needs_admin: "Administrator approval needed",
};

export function ProviderCli(props: { install: ProviderInstall; missing: boolean }) {
  const client = useClient();
  const queries = useQueryClient();
  const { storage } = useLayout();
  const { url } = useDaemonConnection();
  const origin = new URL(url).origin;
  const parsed = InstallAgent.safeParse(
    props.install.acpAgentId ? acpRegistryId(props.install.acpAgentId) : undefined,
  );
  const provider = props.install.kind;
  const agent = parsed.success ? parsed.data : undefined;
  const controller = useMemo(() => {
    const key = `ace.provider.install.${encodeURIComponent(origin)}.${provider}.${agent ?? "default"}`;
    const installed = new CliInstallController(
      client,
      { provider, ...(agent ? { agent } : {}) },
      {
        session: readJson(storage, key, z.string().min(1).max(256).nullable(), null) ?? undefined,
        remember: (session) => writeJson(storage, key, session ?? null),
      },
    );
    return installed;
  }, [client, provider, agent, storage, origin]);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const progress = view.kind === "progress" ? view.progress : undefined;
  useEffect(() => {
    if (progress?.state === "succeeded") refreshProviders(queries);
  }, [progress?.state, queries]);
  if (!controller || (props.install.kind === "acp" && !parsed.success)) return null;
  const running = progress && ["planning", "running", "verifying"].includes(progress.state);
  return (
    <SettingSection label="CLI">
      <div className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {props.install.version
            ? `Version ${props.install.version}`
            : props.missing
              ? "Not installed"
              : "Installed"}
        </span>
        {view.kind === "idle" ? (
          props.missing ? (
            <Button
              size="sm"
              onClick={() => {
                void controller.plan("install");
              }}
            >
              {provider === "antigravity" ? "How to install" : "Install CLI"}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => {
                  void controller.plan("update");
                }}
              >
                Check for updates
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void controller.plan("uninstall");
                }}
              >
                Remove CLI
              </Button>
            </>
          )
        ) : (
          view.kind !== "loading" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (running ? void controller.cancel() : controller.close())}
            >
              {running ? "Cancel" : "Close"}
            </Button>
          )
        )}
      </div>
      {view.kind === "loading" && (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          Preparing installer…
        </p>
      )}
      {view.kind === "error" && (
        <p role="alert" className="py-2 text-sm text-status-failed">
          {view.message}
        </p>
      )}
      {view.kind === "plan" && (
        <div className="flex flex-col gap-2 py-2 text-sm">
          {view.plan.action === "uninstall" && (
            <p>
              Remove {props.install.name}'s CLI from this computer? Its sign-ins and conversations
              stay saved.
            </p>
          )}
          <a
            href={view.plan.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline"
          >
            Official setup instructions
          </a>
          {view.plan.commands.length > 0 && (
            <details>
              <summary className="text-muted-foreground">Details</summary>
              {view.plan.commands.map((command) => (
                <CopyCommand key={command.display} command={command.display} />
              ))}
            </details>
          )}
          {view.plan.latestVersion && (
            <p>
              {view.plan.updateAvailable
                ? `Update available: ${view.plan.latestVersion}`
                : `Latest version: ${view.plan.latestVersion}`}
            </p>
          )}
          {view.plan.status === "ready" && !view.plan.needsAdmin ? (
            <>
              <Button
                size="sm"
                variant={view.plan.action === "uninstall" ? "danger" : "primary"}
                className="self-start"
                onClick={() => {
                  const selected = view.plan.method;
                  if (selected) void controller.run(view.plan.action, selected);
                }}
              >
                {actionNames[view.plan.action]}
              </Button>
            </>
          ) : view.plan.status === "sign_in" ? (
            <SignInButton target={{ provider: props.install.kind }}>Sign in</SignInButton>
          ) : (
            <>
              <p>
                {view.plan.needsAdmin
                  ? "This installer needs administrator approval. Run it in your terminal, then check again."
                  : (view.plan.message ?? "Install this CLI with its own setup, then check again.")}
              </p>
            </>
          )}
        </div>
      )}
      {progress && (
        <div
          role={progress.state === "failed" ? "alert" : "status"}
          className="flex flex-col gap-2 py-2 text-sm"
        >
          <StatusLabel
            tone={
              progress.state === "succeeded"
                ? "done"
                : progress.state === "failed"
                  ? "failed"
                  : "working"
            }
            label={
              progress.state === "running" && progress.action === "uninstall"
                ? "Removing…"
                : progress.state === "running" && progress.action === "update"
                  ? "Updating…"
                  : progressNames[progress.state]
            }
          />
          {progress.state === "running" && <progress aria-label="CLI installation progress" />}
          {progress.state === "failed" && (
            <p>The installer couldn't finish. Try again or use the official setup instructions.</p>
          )}
          {progress.state === "needs_admin" && (
            <p>Run the official installer in your terminal to approve administrator access.</p>
          )}
        </div>
      )}
    </SettingSection>
  );
}
