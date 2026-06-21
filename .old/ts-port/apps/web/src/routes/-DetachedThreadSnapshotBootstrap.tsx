import { useEffect } from "react";
import { ThreadId } from "@ace/contracts";

import { runAsyncTask } from "../lib/async";
import { getRouteRpcClient } from "../lib/remoteWsRouter";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

export function DetachedThreadSnapshotBootstrap(props: {
  threadId: string | null;
  connectionUrl: string | null;
}) {
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerThreadDetailHotPath = useStore((store) => store.syncServerThreadDetailHotPath);
  const { connectionUrl: inputConnectionUrl, threadId } = props;

  useEffect(() => {
    if (!threadId) {
      return;
    }
    const connectionUrl = inputConnectionUrl?.trim() || null;
    let disposed = false;

    runAsyncTask(
      (async () => {
        const targetThreadId = ThreadId.makeUnsafe(threadId);
        const rpcClient = connectionUrl ? getRouteRpcClient(connectionUrl) : null;
        const nativeApi = connectionUrl ? null : readNativeApi();
        const shellSnapshot = rpcClient
          ? await rpcClient.orchestration.getShellSnapshot()
          : await nativeApi?.orchestration.getShellSnapshot();
        const thread = rpcClient
          ? await rpcClient.orchestration.getThread({ threadId: targetThreadId })
          : await nativeApi?.orchestration.getThread({ threadId: targetThreadId });
        if (!shellSnapshot || !thread || disposed) {
          return;
        }
        syncServerShellSnapshot(shellSnapshot);
        syncServerThreadDetailHotPath(
          thread,
          connectionUrl
            ? { connectionUrl, hydrateThreadId: targetThreadId }
            : { hydrateThreadId: targetThreadId },
        );
      })(),
      "Detached editor snapshot bootstrap failed.",
    );

    return () => {
      disposed = true;
    };
  }, [inputConnectionUrl, syncServerShellSnapshot, syncServerThreadDetailHotPath, threadId]);

  return null;
}
