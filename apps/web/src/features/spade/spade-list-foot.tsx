import { GearSixIcon } from "@ace/icons";
import { Link } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { useAccountPicture, useAceAccount } from "@/features/ace-account/index.ts";
import { useProfileName } from "@/lib/profile.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * The list's foot (docs/design/spade.md §2): the person, by picture or initials and name, who
 * opens About you in Spade's Library, and the gear beside it, which opens Settings › Spade.
 * Before the roster names a main bot there is no Library to open, so the person is plain.
 */
export function SpadeListFoot(props: { main: RosterBot | undefined }) {
  const [profileName] = useProfileName();
  const { session } = useAceAccount();
  const picture = useAccountPicture();
  const name = session?.account.name || profileName;
  const shown = name.trim() || "You";
  const who = (
    <>
      <ProfileAvatar name={name} picture={picture} className="size-7 text-2xs" iconSize={14} />
      <span className="min-w-0 truncate text-md text-foreground">{shown}</span>
    </>
  );
  const row = "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 pr-1 focus-ring";
  return (
    <div className="mx-2 mb-1 flex h-12 shrink-0 items-center gap-2 pr-2 pl-2.5">
      {props.main ? (
        <Link
          to="/spade/$agentId"
          params={{ agentId: props.main.id }}
          search={{
            profile: "library",
            ...(props.main.machine.primary ? {} : { on: props.main.machine.key }),
          }}
          aria-label={`${shown}: About you`}
          className={row}
        >
          {who}
        </Link>
      ) : (
        <span className={row}>{who}</span>
      )}
      <Link
        to="/settings/spade"
        aria-label="Settings, Spade"
        title="Settings"
        className="grid size-(--spade-round-button) shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground"
      >
        <Icon icon={GearSixIcon} size={18} />
      </Link>
    </div>
  );
}
