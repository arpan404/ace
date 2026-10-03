import type { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { PreferencesProvider, type Environment } from "@/lib/preferences-context.tsx";
import { createAppRouter } from "./router.ts";

export function createQueryClient(): QueryClient {
  // Daemon reads are local and cheap; retry once, then show the error.
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
}

/** Provider stack shared by the browser entry, Electron (later) and tests. */
export function App(props: {
  client: Client;
  queryClient: QueryClient;
  environment: Environment;
  history?: RouterHistory;
}) {
  const [router] = useState(() =>
    createAppRouter({ client: props.client, queryClient: props.queryClient }, props.history),
  );
  return (
    <ClientProvider client={props.client}>
      <QueryClientProvider client={props.queryClient}>
        <PreferencesProvider environment={props.environment}>
          <LayoutProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </LayoutProvider>
        </PreferencesProvider>
      </QueryClientProvider>
    </ClientProvider>
  );
}
