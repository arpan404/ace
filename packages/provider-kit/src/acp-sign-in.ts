import { rpcErrorCode, type JsonRpcPeer } from "./jsonrpc.ts";

/** ACP's "authentication required" error. */
const authRequired = -32000;
/** Selecting a method the agent already holds credentials for answers at once; never a browser. */
const selectMs = 30_000;

/**
 * Opens an ACP session (`session/new`, `session/load`, a model listing). Some agents, Antigravity's
 * ACP server among them, need a sign-in method selected in every process even with credentials
 * cached. When the agent refuses for want of one and the person signed in with `method`, it is
 * selected and the open runs once more. Any other failure, or none remembered, stays the caller's.
 */
export async function openWithSignIn<T>(
  rpc: Pick<JsonRpcPeer, "request">,
  method: string | undefined,
  open: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await open();
  } catch (error) {
    if (!method || rpcErrorCode(error) !== authRequired) throw error;
  }
  await rpc.request(
    "authenticate",
    { methodId: method },
    {
      ...(signal ? { signal } : {}),
      timeoutMs: selectMs,
    },
  );
  return open();
}
