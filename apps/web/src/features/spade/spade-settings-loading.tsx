import type { ReactNode } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";

/*
 * Settings › Spade while its parts load: each group keeps its heading, and placeholders stand
 * where its rows and values go, so nothing jumps when they arrive and no control shows a value it
 * doesn't have yet. A group keeps one element from loading to loaded: only its rows change.
 */

/** Where a switch goes, its size, until its value is known: never an off switch that may be on. */
export function SwitchSkeleton() {
  return <Skeleton className="h-5 w-[34px] rounded-full" />;
}

/** Where a select or model picker goes, until what it picks from has loaded. */
export function SelectSkeleton() {
  return <Skeleton className="h-7 w-56 max-w-full rounded-md" />;
}

/** A row whose title is known, its control still loading. */
export function LoadingRow(props: { title: string; description?: string; control: ReactNode }) {
  return (
    <SettingRow title={props.title} description={props.description} density="compact">
      {props.control}
    </SettingRow>
  );
}

/** A group's rows while it loads: `rows` placeholder rows at a row's height. */
export function LoadingRows(props: { label: string; rows: number }) {
  return (
    <LoadingRegion label={props.label} className="flex flex-col divide-y divide-border-soft">
      {Array.from({ length: props.rows }, (_, index) => {
        const style = { animationDelay: `${index * 70}ms` };
        return (
          <SettingRow
            key={index}
            title={<Skeleton className="h-3 w-36" style={style} />}
            description={<Skeleton className="mt-1 h-2.5 w-64 max-w-full" style={style} />}
            density="compact"
          />
        );
      })}
    </LoadingRegion>
  );
}
