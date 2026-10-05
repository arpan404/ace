import type { ClientApi } from "@ace/client";
import { ClientProvider, type NotifyBatch } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { BootErrorBoundary } from "@/features/connect/index.ts";
import { LayoutProvider } from "@/lib/layout.tsx";
import { type KeyValueStorage } from "@ace/ui-core";
import { ThemeProvider, type Environment } from "@/theme/theme-provider.tsx";
import { createAppRouter } from "./router.ts";

export function createQueryClient(): QueryClient {
  // Daemon reads are local and cheap; retry once, then show the error.
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
}

/**
 * Providers that do not need a daemon: theme, tooltips, toasts. Wraps the connection screen
 * too. Anything that throws below them shows `BootFailure`, never a blank page or the splash.
 */
export function AppFrame(props: {
  environment: Environment;
  /** Forget the stored daemon and start over at the connection screen (from `BootFailure`). */
  onConnectionSettings?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <ThemeProvider environment={props.environment}>
      <TooltipProvider>
        <ToastProvider>
          <BootErrorBoundary onConnectionSettings={props.onConnectionSettings}>
            {props.children}
          </BootErrorBoundary>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
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
}) {
  const [queryClient] = useState(() => props.queryClient ?? createQueryClient());
  const [router] = useState(() =>
    createAppRouter({ client: props.client, queryClient }, props.history),
  );
  return (
    <ClientProvider client={props.client} {...(props.batch ? { batch: props.batch } : {})}>
      <QueryClientProvider client={queryClient}>
        <LayoutProvider storage={props.storage}>
          <RouterProvider router={router} />
        </LayoutProvider>
      </QueryClientProvider>
    </ClientProvider>
  );
}
