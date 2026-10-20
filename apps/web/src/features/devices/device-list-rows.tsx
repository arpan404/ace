import { formatAgo, type DeviceRow } from "@ace/ui-core";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { deviceKind, type DeviceGroup, type DeviceKind } from "./device-catalog.ts";
import { deviceGlyphs } from "./device-frame.tsx";

const rowBox =
  "group/row relative flex h-8 items-center rounded-md transition-colors duration-(--motion-fast) hover:bg-hover has-[button:focus-visible]:bg-hover";

/** One device as a list row: its kind's glyph, its name, and a quiet line about it. */
function DeviceListRow(props: {
  row: DeviceRow;
  meta: string;
  open: boolean;
  onOpen(): void;
  /** A hover action at the row's end, replacing the meta while shown. */
  action?: { label: string; onClick(): void; disabled?: boolean } | undefined;
}) {
  const { row } = props;
  return (
    <li className={rowBox}>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left focus-ring-inset"
      >
        <Icon
          icon={deviceGlyphs[deviceKind(row)]}
          size={16}
          className="shrink-0 text-faint-foreground group-hover/row:text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{row.name}</span>
        <span
          className={cn(
            "shrink-0 text-xs text-subtle-foreground tabular-nums",
            props.action && "group-focus-within/row:invisible group-hover/row:invisible",
          )}
        >
          {props.meta}
          {props.open && <span className="text-muted-foreground"> · Open</span>}
        </span>
      </button>
      {props.action && (
        <Button
          size="xs"
          variant="secondary"
          disabled={props.action.disabled}
          onClick={props.action.onClick}
          className="absolute right-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
        >
          {props.action.label}
        </Button>
      )}
    </li>
  );
}

/** Devices used lately on this machine: "OS · used 2h ago", and Boot on hover. */
export function RecentRows(props: {
  recent: readonly { row: DeviceRow; at: number }[];
  now: number;
  open: ReadonlySet<string>;
  pending: boolean;
  onOpen(row: DeviceRow): void;
  onBoot(row: DeviceRow): void;
}) {
  return (
    <ul aria-label="Recent devices" className="flex flex-col">
      {props.recent.map(({ row, at }) => (
        <DeviceListRow
          key={row.id}
          row={row}
          meta={[row.runtime, `used ${formatAgo(at, props.now)}`].filter(Boolean).join(" · ")}
          open={props.open.has(row.id)}
          onOpen={() => props.onOpen(row)}
          action={{ label: "Boot", disabled: props.pending, onClick: () => props.onBoot(row) }}
        />
      ))}
    </ul>
  );
}

/**
 * Every device by kind, each kind folded by default with its count. While a search runs every
 * matching kind unfolds, so the matches show.
 */
export function DeviceGroups(props: {
  groups: readonly DeviceGroup[];
  searching: boolean;
  open: ReadonlySet<string>;
  onOpen(row: DeviceRow): void;
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<DeviceKind>>(new Set());
  return (
    <div className="flex flex-col">
      {props.groups.map((group) => {
        const expanded = props.searching || unfolded.has(group.kind);
        return (
          <Disclosure
            key={group.kind}
            open={expanded}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              if (props.searching || next === unfolded.has(group.kind)) return;
              setUnfolded((before) => {
                const after = new Set(before);
                if (next) after.add(group.kind);
                else after.delete(group.kind);
                return after;
              });
            }}
            summaryClassName="h-8 w-full gap-2 rounded-md px-2 text-ui text-foreground transition-colors duration-(--motion-fast) hover:bg-hover"
            summary={
              <>
                <Icon
                  icon={deviceGlyphs[group.kind]}
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <span className="text-xs text-subtle-foreground tabular-nums">
                  {group.rows.length}
                </span>
              </>
            }
          >
            {/* Folded kinds render no rows, so a long list costs only its headings. */}
            {expanded && (
              <ul aria-label={group.label} className="flex flex-col pl-4">
                {group.rows.map((row) => (
                  <DeviceListRow
                    key={row.id}
                    row={row}
                    meta={row.detail}
                    open={props.open.has(row.id)}
                    onOpen={() => props.onOpen(row)}
                  />
                ))}
              </ul>
            )}
          </Disclosure>
        );
      })}
    </div>
  );
}
