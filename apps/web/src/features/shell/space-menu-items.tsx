import { PlusIcon } from "@ace/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  MenuItem,
  MenuLabel,
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu.tsx";
import { personalSpace, roleWord, useSpace } from "@/features/ace-account/index.ts";

/**
 * The account menu's spaces (ADR 0206 §1.5): Personal and each organization the person belongs
 * to, with their role there; the window shows the one picked. Switching signs no one in or out
 * and deletes nothing. Shown once the person is signed in with organizations to offer.
 */
export function SpaceMenuItems() {
  const { spaces, shown, choose, calls } = useSpace();
  const navigate = useNavigate();
  if (!calls || spaces === undefined) return null;
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuLabel>Spaces</MenuLabel>
        <MenuRadioGroup
          value={shown?.id ?? personalSpace}
          onValueChange={(value: string) => choose(value)}
        >
          <MenuRadioItem value={personalSpace} closeOnClick>
            Personal
          </MenuRadioItem>
          {spaces.map((space) => (
            <MenuRadioItem key={space.id} value={space.id} closeOnClick>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{space.name || "Unnamed organization"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {roleWord(space.role)}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuItem
          icon={<PlusIcon aria-hidden />}
          onClick={() => void navigate({ to: "/settings/profile", hash: "organizations" })}
        >
          New organization…
        </MenuItem>
      </MenuGroup>
    </>
  );
}
