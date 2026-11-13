import type { StorageCompaction, StorageKind, StorageUsage } from "@ace/protocol";
import { itemCount, storageLabels } from "@ace/ui-core/host-care";
import { formatBytes } from "@ace/ui-core/byte-size";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { usageBars, type UsageEntry } from "./storage-usage-bars.ts";

type UsageKey = StorageKind | "database";

/** What compaction needs from the page: its last result and how to start or stop it. */
export type CompactionControls = {
  result: StorageCompaction | undefined;
  busy: boolean;
  disabled: boolean;
  onCompact(): void;
  onAbandon(id: string): void;
};

/**
 * The Usage rows, largest first, each with a bar against the largest. Without a measurement
 * every row is unsized and shows a skeleton in the order the kinds are listed.
 */
export function UsageRows(props: {
  kinds: readonly StorageKind[];
  usage: StorageUsage | undefined;
  compaction: CompactionControls;
}) {
  const usage = props.usage;
  const entries: UsageEntry<UsageKey>[] = usage
    ? [
        ...usage.categories.map((category) => ({ key: category.kind, bytes: category.bytes })),
        { key: "database", bytes: usage.databaseBytes },
      ]
    : [
        ...props.kinds.map((kind) => ({ key: kind, bytes: undefined })),
        { key: "database", bytes: undefined },
      ];
  return usageBars(entries).map((row) => {
    const size = <UsageSize bytes={row.bytes} share={row.share} />;
    if (row.key === "database")
      return (
        <SettingRow
          key="database"
          title="Transcript database"
          description={
            usage && <DatabaseDescription usage={usage} result={props.compaction.result} />
          }
          inline
        >
          {usage && <CompactButtons {...props.compaction} />}
          {size}
        </SettingRow>
      );
    const items = usage?.categories.find((category) => category.kind === row.key)?.items;
    return (
      <SettingRow
        key={row.key}
        title={storageLabels[row.key]}
        description={items === undefined ? undefined : itemCount(items)}
        inline
      >
        {size}
      </SettingRow>
    );
  });
}

/** A row's bar and size; the bar gives way under a narrow row, the size stays. */
function UsageSize(props: { bytes: number | undefined; share: number | undefined }) {
  if (props.bytes === undefined) return <Skeleton className="h-3 w-16" />;
  return (
    <span className="flex items-center gap-3">
      <span
        aria-hidden
        className="h-1 w-[110px] overflow-hidden rounded-full bg-fill @max-[440px]:hidden"
      >
        <span
          className="block h-full rounded-full bg-muted-foreground"
          style={{ width: `${(props.share ?? 0) * 100}%` }}
        />
      </span>
      <span className="min-w-14 text-right text-sm tabular-nums text-muted-foreground">
        {formatBytes(props.bytes)}
      </span>
    </span>
  );
}

function DatabaseDescription(props: {
  usage: StorageUsage;
  result: StorageCompaction | undefined;
}) {
  const status = compactionStatus(props.result);
  return (
    <>
      {formatBytes(props.usage.reclaimableDatabaseBytes)} can be reclaimed.
      {status && (
        <>
          {" "}
          <span role="status">{status}</span>
        </>
      )}
    </>
  );
}

/** Incremental compaction gives unused pages back; there is no full rebuild to confirm. */
function compactionStatus(result: StorageCompaction | undefined): string | undefined {
  if (!result) return undefined;
  if (result.incrementalUnavailable)
    return "This database was created before compaction was available and can't shrink in place.";
  if (result.state === "complete")
    return `Compacted from ${formatBytes(result.databaseBytesBefore)} to ${formatBytes(result.databaseBytes)}.`;
  if (result.state === "pending") return "Compaction paused. Resume to continue.";
  return "Compaction stopped.";
}

function CompactButtons(props: CompactionControls) {
  const result = props.result;
  const pending = result?.state === "pending";
  return (
    <>
      {pending && (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Stop compaction"
          disabled={props.busy || props.disabled}
          onClick={() => props.onAbandon(result.id)}
        >
          Stop
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={pending ? "Resume compaction" : "Compact database"}
        disabled={props.busy || props.disabled}
        onClick={props.onCompact}
      >
        {pending ? "Resume" : "Compact"}
      </Button>
    </>
  );
}
