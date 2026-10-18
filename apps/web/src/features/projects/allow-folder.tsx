import { useQueryClient } from "@tanstack/react-query";
import { displayPath, folderName } from "@ace/ui-core";
import { useState } from "react";
import type { ClientApi } from "@ace/client";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { addProjectRoot, saveProjectRoots } from "@/lib/project-roots.ts";

/**
 * Allow a folder outside the machine's allowed places, in one action: no confirmation, an
 * Undo in the toast instead (it restores `roots`, the places allowed before).
 */
export function AllowFolder(props: {
  client: ClientApi | undefined;
  path: string;
  roots: readonly string[];
  onAllowed(): void;
}) {
  const query = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState(false);
  const refresh = () => query.invalidateQueries({ queryKey: ["projects", "folders"] });
  const allow = () => {
    const client = props.client;
    if (!client) return;
    const previous = [...props.roots];
    setPending(true);
    setProblem(false);
    void addProjectRoot(client, props.path)
      .then(async () => {
        await refresh();
        props.onAllowed();
        const id = toast.add({
          title: `Allowed ${displayPath(props.path, undefined)}`,
          actionProps: {
            children: "Undo",
            onClick: () => {
              toast.close(id);
              saveProjectRoots(client, previous)
                .then(refresh)
                .catch(() =>
                  toast.error({
                    title: `Couldn't undo allowing ${folderName(props.path)}. Remove it in Settings.`,
                  }),
                );
            },
          },
        });
      })
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
