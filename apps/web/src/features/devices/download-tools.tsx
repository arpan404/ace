import { toolWords } from "@ace/ui-core";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { channelEndpoint } from "@/boot/main-machine.ts";
import { useDeviceSession } from "./device-session.ts";

/**
 * Downloads the tools ace runs for simulators (serve-sim and the scrcpy server) on the window's
 * machine, through its devices channel. Mounted only when a tool is missing, so a page that
 * shows it opens the channel only then. `done` runs after a download, to read the tools again.
 */
export function DownloadDeviceTools(props: { done(): void }) {
  const { endpoint } = useDaemonConnection();
  const { session } = useDeviceSession(channelEndpoint(endpoint));
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();
  return (
    <Button
      size="sm"
      disabled={!session || downloading}
      onClick={() => {
        if (!session) return;
        setDownloading(true);
        void session.client
          .request({ op: "tools.install" })
          .then(props.done, (cause: unknown) =>
            toast.error({
              title: toolWords.downloadFailed,
              description: cause instanceof Error ? cause.message : undefined,
            }),
          )
          .finally(() => setDownloading(false));
      }}
    >
      {downloading ? toolWords.downloading : toolWords.download}
    </Button>
  );
}
