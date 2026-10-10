import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ThreadRowFlags } from "@ace/ui-core";
import type { ThreadListEntry } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ThreadActionItems } from "@/features/organize/index.ts";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";

/** One hover action; the same registry owns row and header menu entries. */
export function RowActions(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  onHover(): void;
}) {
  return (
    <div
      className="absolute top-1 right-1 hidden group-focus-within/row:block group-hover/row:block has-[[data-popup-open]]:block"
      onPointerEnter={props.onHover}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Menu>
        <MenuTrigger
          render={
            <IconButton icon={DotsThreeIcon} size="sm" label={`Actions for ${props.entry.title}`} />
          }
        />
        <MenuContent align="end">
          <ThreadActionItems
            entry={props.entry}
            flags={props.flags}
            onRename={props.onRename}
            fork={{ point: undefined, onFork: () => {} }}
          />
        </MenuContent>
      </Menu>
    </div>
  );
}
