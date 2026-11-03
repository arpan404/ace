import type { ComponentProps } from "react";
import { initials } from "@ace/ui-core";
import { UserIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";

/** The person's initials on a neutral disc, or a silhouette before they have a name. */
export function ProfileAvatar(props: {
  name: string;
  className: string;
  iconSize: NonNullable<ComponentProps<typeof Icon>["size"]>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-secondary font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)]",
        props.className,
      )}
    >
      {initials(props.name) || (
        <Icon icon={UserIcon} size={props.iconSize} className="text-muted-foreground" />
      )}
    </span>
  );
}
