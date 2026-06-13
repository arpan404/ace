import { useEffect } from "react";

import { METADATA_SNAPSHOT_RECOVERY_INPUT } from "../bootstrapRecovery";
import { runAsyncTask } from "../lib/async";
import { getRouteRpcClient } from "../lib/remoteWsRouter";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

export function DetachedThreadSnapshotBootstrap(props: {
  threadId: string | null;
  connectionUrl: string | null;
}) {
  const mergeServerReadModel = useStore((store) => store.mergeServerReadModel);

  useEffect(() => {
    if (!props.threadId) {
      return;
    }
    const connectionUrl = props.connectionUrl?.trim() || null;
    let disposed = false;

    runAsyncTask(
      (async () => {
        const snapshot = connectionUrl
          ? await getRouteRpcClient(connectionUrl).orchestration.getSnapshot(
              METADATA_SNAPSHOT_RECOVERY_INPUT,
            )
          : await readNativeApi()?.orchestration.getSnapshot(METADATA_SNAPSHOT_RECOVERY_INPUT);
        if (!snapshot || disposed) {
          return;
        }
        mergeServerReadModel(snapshot, {
          hydrateThreadId: METADATA_SNAPSHOT_RECOVERY_INPUT.hydrateThreadId,
          ...(connectionUrl ? { connectionUrl } : {}),
        });
      })(),
      "Detached editor snapshot bootstrap failed.",
    );

    return () => {
      disposed = true;
    };
  }, [mergeServerReadModel, props.connectionUrl, props.threadId]);

  return null;
}
