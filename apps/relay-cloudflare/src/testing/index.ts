import { startWorker } from "./harness.ts";

export { fakeWorkos, type WorkosUser } from "./fake-workos.ts";
export { signInThroughWorker } from "./sign-in.ts";

/** The Worker under Miniflare, as other workspaces' tests see it: its URLs and nothing internal. */
export type RelayWorker = { http: string; relayUrl: string; close(): Promise<void> };

/** Starts ace's relay Worker under real workerd with local D1, signing in through `workosUrl`. */
export async function startRelayWorker(options: { workosUrl: string }): Promise<RelayWorker> {
  const worker = await startWorker({ workosUrl: options.workosUrl });
  return { http: worker.http, relayUrl: worker.relayUrl, close: () => worker.close() };
}
