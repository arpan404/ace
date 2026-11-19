import { useState } from "react";
import type { ClientApi } from "@ace/client";
import { Button } from "@/components/ui/button.tsx";
import { useAllowFolder } from "./use-allow-folder.ts";

/**
 * Allow a folder outside the machine's allowed places, in one action: no confirmation, an
 * Undo in the toast instead (it stops allowing just this folder).
 */
export function AllowFolder(props: {
  client: ClientApi | undefined;
  path: string;
  onAllowed(): void;
}) {
  const allowFolder = useAllowFolder();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState(false);
  const allow = () => {
    const client = props.client;
    if (!client) return;
    setPending(true);
    setProblem(false);
    void allowFolder(client, props.path)
      .then(() => props.onAllowed())
      .catch(() => setProblem(true))
      .finally(() => setPending(false));
  };
  return (
    <>
      <Button size="sm" disabled={!props.client || pending} onClick={allow}>
        {pending ? "Allowing…" : "Allow this folder"}
      </Button>
      {problem && (
        <p role="alert" className="text-sm text-status-failed">
          Couldn't allow this folder. Check that it exists and is accessible, then try again.
        </p>
      )}
    </>
  );
}
