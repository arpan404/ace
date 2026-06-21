import { ProviderInteractionMode } from "@ace/contracts";
import { IconListDetails } from "@tabler/icons-react";
import { PaperclipIcon, PlusIcon } from "lucide-react";
import { type ComponentType, useState } from "react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

export interface CompactComposerCommandMenuItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly command: string;
}

export function PlanModeGlyph(props: { className?: string }) {
  return <IconListDetails aria-hidden="true" className={props.className} />;
}

function SkillGlyph(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10 2.75 11.45 7 15.7 8.45 11.45 9.9 10 14.15 8.55 9.9 4.3 8.45 8.55 7 10 2.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path
        d="M5.1 13.4 5.8 15l1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="M15.2 13.3h2.2M16.3 12.2v2.2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function PluginGlyph(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M7 7h6M7 13h6M7 7v6M13 7v6" stroke="currentColor" strokeLinecap="round" />
      <rect height="4" rx="1.25" stroke="currentColor" width="4" x="3" y="3" />
      <rect height="4" rx="1.25" stroke="currentColor" width="4" x="13" y="3" />
      <rect height="4" rx="1.25" stroke="currentColor" width="4" x="3" y="13" />
      <rect height="4" rx="1.25" stroke="currentColor" width="4" x="13" y="13" />
    </svg>
  );
}

export function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  interactionModeDisabledReason?: string | null;
  skillCommands: ReadonlyArray<CompactComposerCommandMenuItem>;
  pluginCommands: ReadonlyArray<CompactComposerCommandMenuItem>;
  onPickImages: () => void;
  onSelectProviderCommand: (command: string) => void;
  onToggleInteractionMode: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const planModeDisabled = Boolean(
    props.interactionModeDisabledReason && props.interactionMode !== "plan",
  );

  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="size-7 shrink-0 rounded-full p-0 text-muted-foreground/72 hover:bg-black/[0.06] hover:text-foreground/90 dark:hover:bg-white/[0.12]"
            aria-label="More composer controls"
          />
        }
      >
        <PlusIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-[14.5rem]" listClassName="p-1.5">
        <MenuItem
          className="min-h-[2.125rem] rounded-xl text-foreground/92"
          onClick={props.onPickImages}
        >
          <PaperclipIcon aria-hidden="true" className="size-4 text-muted-foreground/82" />
          <span>Add photos & files</span>
        </MenuItem>
        <MenuDivider className="my-1.5" />
        <MenuCheckboxItem
          variant="switch"
          checked={props.interactionMode === "plan"}
          disabled={planModeDisabled}
          className="min-h-[2.125rem] rounded-xl text-foreground/92 [&_[data-slot=menu-checkbox-indicator]]:data-checked:bg-primary/92"
          onCheckedChange={() => {
            if (planModeDisabled) return;
            props.onToggleInteractionMode();
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <PlanModeGlyph className="size-4 text-muted-foreground/82" />
            <span>Plan mode</span>
          </span>
        </MenuCheckboxItem>
        {props.interactionModeDisabledReason ? (
          <div className="px-2 pb-1.5 pt-1 text-muted-foreground/75 text-xs">
            {props.interactionModeDisabledReason}
          </div>
        ) : null}
        <MenuDivider className="my-1.5" />
        <ComposerCommandSubmenu
          label="Skills"
          emptyLabel="No skills"
          commands={props.skillCommands}
          icon={SkillGlyph}
          onSelectProviderCommand={props.onSelectProviderCommand}
        />
        <ComposerCommandSubmenu
          label="Plugins"
          emptyLabel="No plugins"
          commands={props.pluginCommands}
          icon={PluginGlyph}
          onSelectProviderCommand={props.onSelectProviderCommand}
        />
      </MenuPopup>
    </Menu>
  );
}

function ComposerCommandSubmenu(props: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly commands: ReadonlyArray<CompactComposerCommandMenuItem>;
  readonly icon: ComponentType<{ className?: string }>;
  readonly onSelectProviderCommand: (command: string) => void;
}) {
  const Icon = props.icon;
  const itemLabel =
    props.commands.length === 1
      ? props.label.toLowerCase().replace(/s$/, "")
      : props.label.toLowerCase();
  const countLabel = `${props.commands.length} ${itemLabel}`;

  return (
    <MenuSub>
      <MenuSubTrigger
        className="min-h-[2.125rem] rounded-xl text-foreground/92"
        disabled={props.commands.length === 0}
      >
        <Icon aria-hidden="true" className="size-4 text-muted-foreground/82" />
        <span>{props.label}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-[14.5rem]" listClassName="p-1.5" listMaxHeight="18rem">
        {props.commands.length === 0 ? (
          <div className="px-2 py-1 text-muted-foreground/72 text-xs">{props.emptyLabel}</div>
        ) : (
          <>
            <div className="px-2 py-1 text-muted-foreground/72 text-xs">{countLabel}</div>
            {props.commands.map((command) => (
              <MenuItem
                key={command.id}
                className="min-h-[2.125rem] rounded-xl text-foreground/92"
                onClick={() => {
                  props.onSelectProviderCommand(command.command);
                }}
              >
                <Icon aria-hidden="true" className="size-4 text-muted-foreground/82" />
                <span className="min-w-0 truncate">{command.label}</span>
              </MenuItem>
            ))}
          </>
        )}
      </MenuSubPopup>
    </MenuSub>
  );
}
