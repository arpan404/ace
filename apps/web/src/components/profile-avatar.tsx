import { useState, type ComponentProps } from "react";
import { initials } from "@ace/ui-core";
import { UserIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The person's picture on a disc, else their initials, else a silhouette before they have a
 * name. A picture that fails to load falls back to the initials.
 */
export function ProfileAvatar(props: {
  name: string;
  className: string;
  iconSize: NonNullable<ComponentProps<typeof Icon>["size"]>;
  /** The account's picture (`useAccountPicture`). */
  picture?: string | undefined;
}) {
  const [broken, setBroken] = useState<string>();
  if (props.picture && broken !== props.picture)
    return (
      <img
        aria-hidden
        alt=""
        src={props.picture}
        onError={() => setBroken(props.picture)}
        className={cn(
          "shrink-0 rounded-full object-cover shadow-[inset_0_0_0_1px_var(--border)]",
          props.className,
        )}
      />
    );
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
