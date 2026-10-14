import { useSourceControlCache } from "@/lib/source-control-cache.ts";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { useDesktopUpdates } from "@/boot/desktop-updates.ts";
import type { ClientApi } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { ClientProvider, type NotifyBatch } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { BootErrorBoundary } from "@/features/connect/index.ts";
import { StartupScreen } from "@/features/startup/index.ts";
import type { DesktopDaemon } from "@/boot/desktop.ts";
import { StartupContext, type Startup } from "@/lib/startup/startup.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { MachinePoolProvider, MachinePoolFactoryProvider } from "@/lib/machine-pool.ts";
import { type KeyValueStorage } from "@ace/ui-core";
import { ThemeProvider, type Environment } from "@/theme/theme-provider.tsx";
import { disposePanelServices, loadAuthTerminal } from "@/features/panels/index.ts";
import { organizerFor } from "@/features/organize/index.ts";
import { AuthTerminalProvider } from "@/features/sign-in/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { createAppRouter } from "./router.ts";

/** A provider CLI's sign-in terminal: its code and renderer load when someone opens one. */
const AuthTerminal = deferredComponent(() => loadAuthTerminal().then((m) => m.default));

export function createQueryClient(): QueryClient {
  // Daemon reads are local and cheap; retry once, then show the error.
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
}

/**
 * Providers that do not need a daemon: theme, tooltips, toasts. Wraps the connection screen
 * too. Anything that throws below them shows `BootFailure`, never a blank page or the splash.
 * With `startup`, the startup screen covers whatever renders below until the app has its first
 * data; it lives here so it outlasts the swap from connecting to the app and cross-fades once.
 */
export function AppFrame(props: {
  environment: Environment;
  /** Forget the stored daemon and start over at the connection screen (from `BootFailure`). */
  onConnectionSettings?: (() => void) | undefined;
  startup?: Startup | undefined;
  /** The desktop's daemon controls, for the startup screen's status and recovery. */
  daemon?: DesktopDaemon | undefined;
  children: ReactNode;
}) {
  return (
    // Outside the providers too: if theme, tooltips or toasts fail, this still says so.
    <BootErrorBoundary bare>
      <StartupContext.Provider value={props.startup}>
        <ThemeProvider environment={props.environment}>
          <TooltipProvider>
            <ToastProvider>
              <BootErrorBoundary onConnectionSettings={props.onConnectionSettings}>
                <LocalBoundary label="update status" fallback={null}>
                  <DesktopUpdates />
                </LocalBoundary>
                {props.children}
              </BootErrorBoundary>
              {props.startup && (
                <LocalBoundary label="the startup screen" fallback={null}>
                  <StartupScreen daemon={props.daemon} />
                </LocalBoundary>
              )}
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </StartupContext.Provider>
    </BootErrorBoundary>
  );
}

/** Everything bound to one daemon client. Shared by the browser entry, Electron and tests. */
export function App(props: {
  client: ClientApi;
  queryClient?: QueryClient;
  storage?: KeyValueStorage | undefined;
  history?: RouterHistory;
  /** When store changes reach React; the browser entry batches them per animation frame. */
  batch?: NotifyBatch;
  /** The user's other machines (ADR 0059); pickers that target a machine offer them. */
  machines?: MachinePool | undefined;
  ensureMachines?: (() => Promise<MachinePool>) | undefined;
}) {
  useEffect(() => () => disposePanelServices(props.client), [props.client]);
  const [queryClient] = useState(() => props.queryClient ?? createQueryClient());
  const [router] = useState(() => {
    const project = organizerFor(props.storage).getState().project;
    void props.client.threadsWindow(project ? { project } : {});
    return createAppRouter({ client: props.client, queryClient }, props.history);
  });
  return (
    <ClientProvider client={props.client} {...(props.batch ? { batch: props.batch } : {})}>
      <QueryClientProvider client={queryClient}>
        <SourceControlCache client={props.client} />
        <LayoutProvider storage={props.storage}>
          <MachinePoolFactoryProvider value={props.ensureMachines}>
            <MachinePoolProvider value={props.machines}>
              <AuthTerminalProvider value={AuthTerminal.Component}>
                <RouterProvider router={router} />
              </AuthTerminalProvider>
            </MachinePoolProvider>
          </MachinePoolFactoryProvider>
        </LayoutProvider>
      </QueryClientProvider>
    </ClientProvider>
  );
}

function DesktopUpdates() {
  useDesktopUpdates();
  return null;
}

function SourceControlCache({ client }: { client: ClientApi }) {
  useSourceControlCache(client);
  return null;
}
