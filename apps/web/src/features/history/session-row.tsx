import type { HistorySession } from "@ace/protocol";
import { formatAgo } from "@ace/ui-core";
import { ArrowSquareInIcon, PlayIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { useNow } from "@/lib/time.ts";

export type SessionAction = (session: HistorySession, action: "import" | "continue") => void;

export function SessionRow(props: { session: HistorySession; busy: boolean; open: SessionAction }) {
  const { session, busy, open } = props;
  const now = useNow();
  return (
    <li className="group flex h-9 min-w-0 items-center gap-2 text-sm">
      <ProviderIconTip provider={session.provider} size={14} />
      <span className="min-w-0 flex-1 truncate" title={session.title}>
        {session.title}
      </span>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={new Date(session.lastActivity).toISOString()}
      >
        {formatAgo(session.lastActivity, now)}
      </time>
      <div className="flex w-14 shrink-0 justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <IconButton
          icon={ArrowSquareInIcon}
          size="sm"
          label={`Import ${session.title}`}
          tip="Import saved conversation"
          disabled={busy}
          onClick={() => open(session, "import")}
        />
        {session.continuation?.status === "supported" && (
          <IconButton
            icon={PlayIcon}
            size="sm"
            label={`Continue ${session.title}`}
            tip="Continue in the original provider"
            disabled={busy}
            onClick={() => open(session, "continue")}
          />
        )}
      </div>
    </li>
  );
}
