import { fileLanguages } from "@ace/ui-core";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import {
  indentText,
  languageName,
  lineEndingText,
  positionText,
  type EditorStatus,
  type EditorStatusActions,
} from "./editor-status.ts";

/*
 * The editor's status line: where the caret is, what is selected, and the file's indentation,
 * line ending, encoding and language. The last three that can change are words that open a
 * menu, as VS Code's are; nothing here draws an icon.
 */

const trigger =
  "h-5 rounded-sm px-1.5 text-xs text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none";

/** One editor's status line, drawn from its status; a workbench can draw it for any editor. */
export function EditorStatusLine({
  status,
  actions,
}: {
  status: EditorStatus;
  actions: EditorStatusActions;
}) {
  const plain = "plain";
  const props = {
    ...status,
    onIndent: actions.setIndent,
    onLineEnding: actions.setLineEnding,
    onLanguage: (language: string | undefined) => actions.setLanguage(language),
    onWhitespace: actions.setWhitespace,
  };
  return (
    <footer
      aria-label="Editor status"
      className="flex h-6 shrink-0 items-center gap-0.5 border-t bg-background px-1.5 text-xs text-muted-foreground tabular-nums"
    >
      <span className="mr-auto truncate px-1.5">{positionText(status)}</span>
      <Menu>
        <MenuTrigger aria-label={`Indentation: ${indentText(props.indent)}`} className={trigger}>
          {indentText(props.indent)}
        </MenuTrigger>
        <MenuContent align="end" side="top">
          <MenuGroup>
            <MenuLabel>Indent with</MenuLabel>
            <MenuRadioGroup
              value={props.indent.tabs ? "tabs" : "spaces"}
              onValueChange={(value) =>
                props.onIndent({ tabs: value === "tabs", size: props.indent.size })
              }
            >
              <MenuRadioItem value="spaces" disabled={props.readOnly}>
                Spaces
              </MenuRadioItem>
              <MenuRadioItem value="tabs" disabled={props.readOnly}>
                Tabs
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuLabel>Size</MenuLabel>
            <MenuRadioGroup
              value={String(props.indent.size)}
              onValueChange={(value) =>
                props.onIndent({ tabs: props.indent.tabs, size: Number(value) })
              }
            >
              {[2, 4, 8].map((size) => (
                <MenuRadioItem key={size} value={String(size)}>
                  {size}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={props.whitespace}
            onCheckedChange={(checked) => props.onWhitespace(checked)}
          >
            Show whitespace
          </MenuCheckboxItem>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger
          aria-label={`Line endings: ${lineEndingText(props.lineEnding)}`}
          className={trigger}
          disabled={props.readOnly}
        >
          {lineEndingText(props.lineEnding)}
        </MenuTrigger>
        <MenuContent align="end" side="top">
          <MenuRadioGroup
            value={props.lineEnding === "\r\n" ? "crlf" : "lf"}
            onValueChange={(value) => props.onLineEnding(value === "crlf" ? "\r\n" : "\n")}
          >
            <MenuRadioItem value="lf">LF</MenuRadioItem>
            <MenuRadioItem value="crlf">CRLF</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <span className="px-1.5">{status.encoding}</span>
      <Menu>
        <MenuTrigger aria-label={`Language: ${languageName(props.language)}`} className={trigger}>
          {languageName(props.language)}
        </MenuTrigger>
        <MenuContent align="end" side="top" className="max-h-[50vh] overflow-y-auto">
          <MenuRadioGroup
            value={props.language ?? plain}
            onValueChange={(value) =>
              props.onLanguage(typeof value === "string" && value !== plain ? value : undefined)
            }
          >
            <MenuRadioItem value={plain}>Plain Text</MenuRadioItem>
            {fileLanguages.map((language) => (
              <MenuRadioItem key={language} value={language}>
                {languageName(language)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </footer>
  );
}
