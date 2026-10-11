import { PlayIcon } from "@phosphor-icons/react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useRunScript, useScripts } from "../lib/use-scripts.ts";
import type { ThreadRef } from "../sources/index.ts";

/** Project scripts remain available in the project's menu, without occupying card rows. */
export function ProjectScriptItems(props: { thread: ThreadRef; onClose(): void }) {
  const query = useScripts(props.thread);
  const { run } = useRunScript(props.thread);
  if (query.isError)
    return (
      <MenuItem onClick={() => void query.refetch()}>Couldn't read scripts. Try again</MenuItem>
    );
  if (!query.data?.length) return null;
  return query.data.map((script) => (
    <MenuItem
      key={script.id}
      icon={<PlayIcon aria-hidden size={14} />}
      onClick={() => {
        void run(script);
        props.onClose();
      }}
    >
      Run {script.command}
    </MenuItem>
  ));
}
