import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { MenuContent, MenuItem } from "@/components/ui/menu.tsx";
import { morePages } from "./pages.ts";

/** The rail's ⋯ menu: each of More's pages, a compact popover anchored to the button. */
export function MoreMenuItems() {
  const navigate = useNavigate();
  return (
    <MenuContent side="right" align="start">
      {morePages.map((page) => (
        <MenuItem
          key={page.to}
          icon={<Icon icon={page.icon} />}
          onClick={() => void navigate({ to: page.to })}
        >
          {page.title}
        </MenuItem>
      ))}
    </MenuContent>
  );
}
