import type { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { type KeyValueStorage } from "@ace/ui-core";
import { ThemeProvider, type Environment } from "@/theme/theme-provider.tsx";
import { createAppRouter } from "./router.ts";

export function createQueryClient(): QueryClient {
  // Daemon reads are local and cheap; retry once, then show the error.
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
}

/** Providers that do not need a daemon: theme, tooltips, toasts. Wraps the connection screen too. */
export function AppFrame(props: { environment: Environment; children: ReactNode }) {
  return (
    <ThemeProvider environment={props.environment}>
      <TooltipProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

/** Everything bound to one daemon client. Shared by the browser entry, Electron and tests. */
export function App(props: {
  client: Client;
  queryClient?: QueryClient;
  storage?: KeyValueStorage | undefined;
  history?: RouterHistory;
}) {
  const [queryClient] = useState(() => props.queryClient ?? createQueryClient());
  const [router] = useState(() =>
    createAppRouter({ client: props.client, queryClient }, props.history),
  );
  return (
    <ClientProvider client={props.client}>
      <QueryClientProvider client={queryClient}>
        <LayoutProvider storage={props.storage}>
          <RouterProvider router={router} />
        </LayoutProvider>
      </QueryClientProvider>
    </ClientProvider>
  );
}
