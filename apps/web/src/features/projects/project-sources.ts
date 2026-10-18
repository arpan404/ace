import { FolderOpenIcon, FolderPlusIcon, GithubLogoIcon, LinkIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { PalettePage } from "@/lib/layout.tsx";

export type AddPage = Extract<PalettePage, `add-${string}`>;

/** Add project's sources: one name and icon each, everywhere they show. */
export const projectSources: readonly { page: AddPage; label: string; icon: IconGlyph }[] = [
  { page: "add-local", label: "Local folder", icon: FolderOpenIcon },
  { page: "add-create", label: "New project", icon: FolderPlusIcon },
  { page: "add-clone", label: "Git URL", icon: LinkIcon },
  { page: "add-github", label: "GitHub repository", icon: GithubLogoIcon },
];

/** Whether a palette step belongs to Add project. */
export function isAddPage(page: PalettePage | undefined): page is AddPage {
  return page?.startsWith("add-") ?? false;
}
