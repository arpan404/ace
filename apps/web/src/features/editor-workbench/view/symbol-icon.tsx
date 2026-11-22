import {
  CodeIcon,
  CubeIcon,
  PackageIcon,
  ShapesIcon,
  TagIcon,
  TextHIcon,
  type IconProps,
} from "@ace/icons";
import type { SymbolKind } from "@ace/ui-core/editor-workbench";
import type { ComponentType } from "react";
import { cn } from "@/lib/cn.ts";

const iconByKind: Record<SymbolKind, ComponentType<IconProps>> = {
  function: CodeIcon,
  method: CodeIcon,
  class: CubeIcon,
  struct: CubeIcon,
  interface: ShapesIcon,
  type: ShapesIcon,
  enum: ShapesIcon,
  const: TagIcon,
  module: PackageIcon,
  heading: TextHIcon,
};

const toneByKind: Record<SymbolKind, string> = {
  function: "text-accent-foreground",
  method: "text-accent-foreground",
  class: "text-warning-foreground",
  struct: "text-warning-foreground",
  interface: "text-info-foreground",
  type: "text-info-foreground",
  enum: "text-warning-foreground",
  const: "text-muted-foreground",
  module: "text-muted-foreground",
  heading: "text-muted-foreground",
};

export const symbolKindLabel: Record<SymbolKind, string> = {
  function: "Function",
  method: "Method",
  class: "Class",
  struct: "Struct",
  interface: "Interface",
  type: "Type",
  enum: "Enum",
  const: "Constant",
  module: "Module",
  heading: "Heading",
};

/** Bare `@ace/icons` glyph for a document symbol kind. */
export function SymbolIcon(props: { kind: SymbolKind; size?: number; className?: string }) {
  const Glyph = iconByKind[props.kind];
  return (
    <Glyph
      aria-hidden
      size={props.size ?? 13}
      className={cn("shrink-0", toneByKind[props.kind], props.className)}
    />
  );
}
