import { type VirtualItem } from "@tanstack/react-virtual";
import { memo, type CSSProperties, type ReactNode } from "react";

import type { TimelineRow } from "~/lib/chat/timelineRows";

export function TimelineViewport(props: {
  readonly buildRowContent: (row: TimelineRow, rowIndex: number) => ReactNode;
  readonly buildRowRenderCacheStyle: (row: TimelineRow, style?: CSSProperties) => CSSProperties;
  readonly measureVirtualizedRowElement: (element: HTMLElement | null) => void;
  readonly renderedVirtualItems: readonly VirtualItem[];
  readonly shouldRenderVirtualizedBuffer: boolean;
  readonly trailingRows: readonly TimelineRow[];
  readonly virtualizedBufferHeight: number;
  readonly virtualizedRows: readonly TimelineRow[];
}) {
  return (
    <>
      {props.shouldRenderVirtualizedBuffer ? (
        <div
          data-virtualizer-buffer="true"
          className="relative"
          style={{ height: `${props.virtualizedBufferHeight}px` }}
        >
          {props.renderedVirtualItems.map((virtualRow) => {
            const row = props.virtualizedRows[virtualRow.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={`row:${row.id}`}
                ref={props.measureVirtualizedRowElement}
                data-index={virtualRow.index}
                data-timeline-row-id={row.id}
                className="timeline-row-render-cache absolute top-0 left-0 flow-root w-full"
                style={props.buildRowRenderCacheStyle(row, {
                  transform: `translateY(${virtualRow.start}px)`,
                })}
              >
                {props.buildRowContent(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        props.virtualizedRows.map((row, index) => (
          <div
            key={`row:${row.id}`}
            data-timeline-row-id={row.id}
            className="timeline-row-render-cache"
            style={props.buildRowRenderCacheStyle(row)}
          >
            {props.buildRowContent(row, index)}
          </div>
        ))
      )}
      {props.trailingRows.map((row, index) => (
        <div
          key={`row:${row.id}`}
          data-timeline-row-id={row.id}
          className="timeline-row-render-cache"
          style={props.buildRowRenderCacheStyle(row)}
        >
          {props.buildRowContent(row, props.virtualizedRows.length + index)}
        </div>
      ))}
    </>
  );
}
