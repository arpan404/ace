import type { ServerOptions } from "./server-options.ts";
import type { WebOriginAllowlist } from "./web-origins.ts";

const key = "remote.hostedWebApp";

/**
 * Keep the hosted web app's origin in step with `remote.hostedWebApp`, applied without a restart.
 * Returns the unsubscribe.
 */
export async function followHostedWebApp(
  settings: ServerOptions["settings"],
  origins: WebOriginAllowlist,
): Promise<() => void> {
  if (!settings) return () => {};
  let latest = 0;
  const refresh = async () => {
    const turn = ++latest;
    const read = await settings.read({ keys: [key], scope: {} });
    if (turn !== latest) return;
    const entry = read.entries.find((item) => item.key === key);
    origins.allowHosted(entry?.value === true);
  };
  await refresh();
  const stop = await settings.subscribe({ keys: [key], scope: {} }, (event) => {
    if (event.type === "changed") void refresh().catch(() => origins.allowHosted(false));
  });
  return stop;
}
