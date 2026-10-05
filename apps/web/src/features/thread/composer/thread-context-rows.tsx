import { permissionModes } from "@ace/client";
import { useThreadMeta } from "@ace/client-react";
import { providerNames } from "@ace/ui-core";
import { GlobeSimpleIcon, ListChecksIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { contextPages } from "./context-pages.ts";
import { usePermissionCapabilities, useSetThreadPermission } from "./permission-hooks.ts";

/** At most this many open pages are offered; the rest are a tab away. */
const shownPages = 3;

/**
 * The + menu's rows that belong to this thread: Plan first (read-only approvals until the plan
 * is agreed), and the pages open in its workspace as context for the message.
 */
export function ThreadContextRows(props: { thread: ThreadRef; onInsert(text: string): void }) {
  const meta = useThreadMeta(props.thread.id);
  const workspace = useScopeWorkspace(props.thread.id);
  const toast = useToast();
  const set = useSetThreadPermission(props.thread.id);
  const { capabilities, loading } = usePermissionCapabilities(
    meta?.provider,
    meta?.capabilities?.permissions,
  );
  const mode = meta?.permission?.override ?? meta?.permission?.effective;
  const provider = meta ? providerNames[meta.provider] : "This provider";
  const planReason =
    loading || !meta
      ? "Checking what the provider can gate"
      : !permissionModes(capabilities).includes("read-only")
        ? `${provider} has no read-only mode to plan in`
        : mode === "read-only"
          ? "Already read only"
          : undefined;
  const pages = contextPages(workspace).slice(0, shownPages);
  return (
    <MenuGroup aria-label="This thread">
      <MenuItem
        icon={<Icon icon={ListChecksIcon} />}
        reason={planReason}
        disabled={!!planReason}
        onClick={() =>
          void set("read-only").then(
            () =>
              toast.add({
                title: "Approvals: Read only",
                description: "The agent plans from its next turn; switch back to let it act.",
              }),
            (error: unknown) =>
              toast.add({ title: "Couldn't change approvals", description: failureMessage(error) }),
          )
        }
      >
        Plan first
      </MenuItem>
      {pages.length ? (
        pages.map((page) => (
          <MenuItem
            key={page.url}
            icon={<Icon icon={GlobeSimpleIcon} />}
            aria-label={`Add ${page.label} to the message`}
            onClick={() => props.onInsert(`${page.url} `)}
          >
            {page.label}
          </MenuItem>
        ))
      ) : (
        <MenuItem
          icon={<Icon icon={GlobeSimpleIcon} />}
          reason="Open a page in the Browser first"
          disabled
        >
          An open page
        </MenuItem>
      )}
    </MenuGroup>
  );
}
