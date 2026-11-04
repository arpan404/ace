import type { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import { AceAccountProvider } from "@/features/ace-account/index.ts";
import { LayoutProvider } from "@/lib/layout.tsx";
import { MachinePoolFactoryProvider, MachinePoolProvider } from "@/lib/machine-pool.ts";
import { createNoMachineRouter } from "./routes.tsx";

/**
 * The app in a window with no machine (no daemon chosen yet): the same frame, with Threads
 * saying to add a machine and Settings' Profile (sign in to an ace account) and Fleet (pair a
 * machine, connect by address, or open one on the account). Choosing a machine goes through
 * the connection gate, which then opens the full app for it.
 */
export function NoMachineApp(props: {
  storage?: KeyValueStorage | undefined;
  /** Storage for this window alone that outlives a reload (session storage). */
  windowStorage?: KeyValueStorage | undefined;
  history?: RouterHistory;
  /** The machine pool, for opening machines on the ace account. */
  machines?: MachinePool | undefined;
  ensureMachines?: (() => Promise<MachinePool>) | undefined;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );
  const [router] = useState(() => createNoMachineRouter(props.history));
  return (
    <QueryClientProvider client={queryClient}>
      <LayoutProvider storage={props.storage} windowStorage={props.windowStorage}>
        <MachinePoolFactoryProvider value={props.ensureMachines}>
          <MachinePoolProvider value={props.machines}>
            <AceAccountProvider>
              <RouterProvider router={router} />
            </AceAccountProvider>
          </MachinePoolProvider>
        </MachinePoolFactoryProvider>
      </LayoutProvider>
    </QueryClientProvider>
  );
}
