import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * The account's usage meter beside the context meter and the near-limit warning above the
 * composer. They read `accounts.list`, so their code loads after the thread has painted, warmed
 * while idle with the rest of `preloadDeferred`.
 */
export const DeferredAccountMeter = deferredComponent(() =>
  import("./account-usage.tsx").then((module) => module.AccountMeter),
);
export const DeferredLimitWarning = deferredComponent(() =>
  import("./account-usage.tsx").then((module) => module.LimitWarning),
);
