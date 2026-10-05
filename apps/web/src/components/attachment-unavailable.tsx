import { ImageIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

/** Bytes this device can't reach: a quiet tile with the name, so the message still reads. */
export function UnavailableTile(props: { name: string; style?: CSSProperties }) {
  return (
    <span
      role="img"
      aria-label={`${props.name}: image unavailable on this device`}
      style={props.style ?? { width: 240, height: 120 }}
      className="inline-flex flex-col items-center justify-center gap-1 overflow-hidden rounded-[10px] bg-secondary px-3 text-center text-xs text-muted-foreground"
    >
      <ImageIcon aria-hidden size={18} className="text-subtle-foreground" />
      <span aria-hidden>Image unavailable on this device</span>
      <span aria-hidden className="w-full truncate text-subtle-foreground">
        {props.name}
      </span>
    </span>
  );
}
