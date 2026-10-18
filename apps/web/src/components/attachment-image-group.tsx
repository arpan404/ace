import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import type { ImageCell, ImageLayout } from "./attachment-format.ts";

/**
 * The cells of an image group on their grid: the group's outer corners are a card's, its cells'
 * a control's, 4px apart. The placeholder draws the same grid with skeletons.
 */
export function ImageGroup(props: {
  layout: ImageLayout;
  label?: string | undefined;
  renderCell(cell: ImageCell): ReactNode;
}) {
  const { kind, cells } = props.layout;
  return (
    <ul
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      data-layout={kind}
      className={cn(
        "grid w-fit max-w-full gap-1 overflow-hidden rounded-lg",
        kind !== "single" && "grid-cols-2",
      )}
    >
      {cells.map((cell) => (
        <li key={cell.image.key} className={cn("min-w-0 max-w-full", cell.tall && "row-span-2")}>
          {props.renderCell(cell)}
        </li>
      ))}
    </ul>
  );
}
