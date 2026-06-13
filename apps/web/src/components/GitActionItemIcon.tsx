import { CloudUploadIcon, GitCommitIcon } from "lucide-react";

import type { GitActionIconName } from "../lib/git/actions";
import { GitHubIcon } from "./Icons";

export function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}
