import type { ComponentProps } from "react";

import BranchToolbar from "../BranchToolbar";

export type DraftBranchToolbarProps = {
  branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
};

export function DraftBranchToolbar({ branchToolbarProps }: DraftBranchToolbarProps) {
  return branchToolbarProps ? <BranchToolbar {...branchToolbarProps} presentation="draft" /> : null;
}
