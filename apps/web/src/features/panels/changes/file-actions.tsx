import {
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  CheckSquareIcon,
  CopyIcon,
  DotsThreeIcon,
  SquareIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The end of a file's header: Viewed (folds the file and remembers this version of its diff as
 * read; a later edit to the file clears it) and the file's menu.
 */
export function FileActions(props: {
  path: string;
  viewed: boolean;
  open: boolean;
  onViewed(viewed: boolean): void;
  onOpen(open: boolean): void;
}) {
  const toast = useToast();
  const copy = () => {
    void navigator.clipboard?.writeText(props.path).then(
      () => toast.add({ title: "Path copied", description: props.path }),
      () => toast.add({ title: "Couldn't copy the path" }),
    );
  };
  return (
    <>
      <button
        type="button"
        aria-pressed={props.viewed}
        onClick={() => props.onViewed(!props.viewed)}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-ring",
          props.viewed && "text-foreground",
        )}
      >
        <Icon icon={props.viewed ? CheckSquareIcon : SquareIcon} size={14} active={props.viewed} />
        Viewed
      </button>
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              label={`Actions for ${props.path}`}
              size="sm"
              tooltip={false}
            />
          }
        />
        <MenuContent align="end">
          <MenuItem icon={<CopyIcon aria-hidden size={16} />} onClick={copy}>
            Copy path
          </MenuItem>
          <MenuItem
            icon={
              props.open ? (
                <ArrowsInLineVerticalIcon aria-hidden size={16} />
              ) : (
                <ArrowsOutLineVerticalIcon aria-hidden size={16} />
              )
            }
            onClick={() => props.onOpen(!props.open)}
          >
            {props.open ? "Collapse file" : "Expand file"}
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}
