import { ChartBarIcon, FilesIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";

/** The less frequent places: More's list and the sidebar's More menu both read this. */
export const morePages: readonly {
  to: "/more/accounts" | "/more/files" | "/more/search";
  title: string;
  description: string;
  icon: IconGlyph;
}[] = [
  {
    to: "/more/accounts",
    title: "Usage & accounts",
    description: "Quota per account window, scheduling",
    icon: ChartBarIcon,
  },
  {
    to: "/more/files",
    title: "Files",
    description: "Changed files across threads",
    icon: FilesIcon,
  },
  {
    to: "/more/search",
    title: "Search",
    description: "Full-text search in every thread",
    icon: MagnifyingGlassIcon,
  },
];
