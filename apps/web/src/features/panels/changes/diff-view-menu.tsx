import type { ReactElement, ReactNode } from "react";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import type { DiffPrefs } from "./diff-prefs.ts";

const modeLabels: Record<DiffPrefs["mode"], string> = {
  auto: "Auto",
  unified: "Unified",
  split: "Split",
};

/**
 * The View menu every diff viewer shares (the Changes panel, a pull request's Code tab): layout,
 * wrapping, folds, visible whitespace, the files tree and folding every file. A viewer adds its
 * own choices (`options`), actions (`actions`) and notes (`footer`) around the shared ones.
 */
export function DiffViewMenu(props: {
  /** The button that opens the menu, in the toolbar's own style. */
  trigger: ReactElement;
  prefs: DiffPrefs;
  onPrefs(change: Partial<DiffPrefs>): void;
  /** The layout drawn, which Auto names. */
  shown: "unified" | "split";
  splitTooNarrow: boolean;
  /** The tree only helps with more than one file. */
  canShowTree: boolean;
  allCollapsed: boolean;
  onCollapseAll(fold: boolean): void;
  options?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const { prefs, onPrefs } = props;
  return (
    <Menu>
      <MenuTrigger render={props.trigger} />
      <MenuContent align="end" className="w-56">
        <MenuRadioGroup
          value={prefs.mode}
          onValueChange={(mode: DiffPrefs["mode"]) => onPrefs({ mode })}
        >
          <MenuLabel>Layout</MenuLabel>
          <MenuRadioItem closeOnClick value="auto">
            Auto · {modeLabels[props.shown]}
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="unified">
            Unified
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="split">
            Split{props.splitTooNarrow && " · needs more width"}
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={prefs.fold} onCheckedChange={(fold) => onPrefs({ fold })}>
          Fold unchanged lines
        </MenuCheckboxItem>
        <MenuCheckboxItem checked={prefs.wrap} onCheckedChange={(wrap) => onPrefs({ wrap })}>
          Wrap lines
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={prefs.whitespace}
          onCheckedChange={(whitespace) => onPrefs({ whitespace })}
        >
          Show spaces and tabs
        </MenuCheckboxItem>
        {props.options}
        {props.canShowTree && (
          <MenuCheckboxItem checked={prefs.tree} onCheckedChange={(tree) => onPrefs({ tree })}>
            File tree
          </MenuCheckboxItem>
        )}
        <MenuSeparator />
        <MenuItem onClick={() => props.onCollapseAll(!props.allCollapsed)}>
          {props.allCollapsed ? "Expand all files" : "Collapse all files"}
        </MenuItem>
        {props.actions}
        {props.footer}
      </MenuContent>
    </Menu>
  );
}
