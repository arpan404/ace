import { ChartBarIcon, FilesIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";

/** The less frequent places, listed by the rail's ⋯ menu. */
export const morePages: readonly {
  to: "/more/accounts" | "/more/files" | "/more/search";
  title: string;
  icon: IconGlyph;
}[] = [
  {
    to: "/more/accounts",
    title: "Usage & accounts",
    icon: ChartBarIcon,
  },
  {
    to: "/more/files",
    title: "Files",
    icon: FilesIcon,
  },
  {
    to: "/more/search",
    title: "Search",
    icon: MagnifyingGlassIcon,
  },
];
