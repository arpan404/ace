import { DotsThreeIcon } from "@phosphor-icons/react";
import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger, MenuSeparator, MenuItem } from "@/components/ui/menu.tsx";

const row = "flex flex-wrap items-center gap-1.5";

/**
 * The folded header's ⋯: the actions in a row, the header's tools (on a phone: the work card
 * and the side panel's toggle) in another, then the title menu behind one more tap. Loaded when
 * a header first folds (`AppHeader`), so a wide window never fetches the popover. With tools it
 * stays mounted while closed, so their shortcuts keep working.
 */
export function Overflow(props: {
  actions: ReactNode;
  tools?: ReactNode;
  menu: ReactNode;
  label: string;
  /** The ⋯ was pressed while this code loaded: open at once. */
  defaultOpen: boolean;
}) {
  // Held here: an uncontrolled popover mounted with `defaultOpen` stayed closed after a press on
  // the placeholder ⋯ (the case `defaultOpen` exists for).
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<IconButton icon={DotsThreeIcon} label={props.label} />} />
      <MenuContent align="end" className="min-w-56">
        {props.actions && <div className={row}>{props.actions}</div>}
        {props.tools && (
          <div className="flex flex-col" onClick={() => setOpen(false)}>
            {labelTools(props.tools)}
          </div>
        )}
        {(props.actions || props.tools) && props.menu && <MenuSeparator />}
        {props.menu}
      </MenuContent>
    </Menu>
  );
}
function labelTools(nodes: ReactNode): ReactNode {
  return Children.map(nodes, (node) => {
    if (
      !isValidElement<Partial<ComponentProps<typeof IconButton>> & { children?: ReactNode }>(node)
    )
      return node;
    if (node.props.label)
      return (
        <MenuItem render={<button type="button" onClick={node.props.onClick} />}>
          {node.props.label === "Work card" ? "Details" : node.props.label}
        </MenuItem>
      );
    return node.props.children
      ? cloneElement(node, { children: labelTools(node.props.children) })
      : node;
  });
}
