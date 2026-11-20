import type { Indent, Selection } from "@ace/editor";
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

/*
 * The editor's status line: where the caret is, what is selected, and the file's indentation,
 * line ending, encoding and language. The last three that can change are words that open a
 * menu, as VS Code's are; nothing here draws an icon.
 */

const names: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  json5: "JSON5",
  python: "Python",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  cs: "C#",
};

/** A language's name as people say it. */
export function languageName(language: string | undefined): string {
  if (!language) return "Plain Text";
  return names[language] ?? language;
}

/** "Ln 3, Col 5", with the selection after it: "(12 selected)", "(3 lines)" or "4 selections". */
export function positionText(selections: readonly Selection[], primary: number): string {
  const current = selections[primary] ?? selections[0];
  if (!current) return "Ln 1, Col 1";
  const where = `Ln ${current.head.line + 1}, Col ${current.head.column + 1}`;
  if (selections.length > 1) return `${where} (${selections.length} selections)`;
  const { anchor, head } = current;
  if (anchor.line === head.line) {
    const count = Math.abs(head.column - anchor.column);
    return count ? `${where} (${count} selected)` : where;
  }
  return `${where} (${Math.abs(head.line - anchor.line) + 1} lines)`;
}

/** "Spaces: 2" or "Tab Size: 4", VS Code's words. */
export function indentText(indent: Indent): string {
  return indent.tabs ? `Tab Size: ${indent.size}` : `Spaces: ${indent.size}`;
}

const trigger =
  "h-5 rounded-sm px-1.5 text-xs text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none";

export function EditorStatusLine(props: {
  selections: readonly Selection[];
  primary: number;
  indent: Indent;
  lineEnding: "\n" | "\r\n";
  language: string | undefined;
  whitespace: boolean;
  readOnly: boolean;
  onIndent(indent: Indent): void;
  onLineEnding(ending: "\n" | "\r\n"): void;
  onLanguage(language: string | undefined): void;
  onWhitespace(show: boolean): void;
}) {
  const plain = "plain";
  return (
    <footer
      aria-label="Editor status"
      className="flex h-6 shrink-0 items-center gap-0.5 border-t bg-background px-1.5 text-xs text-muted-foreground tabular-nums"
    >
      <span className="mr-auto truncate px-1.5">
        {positionText(props.selections, props.primary)}
      </span>
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
          aria-label={`Line endings: ${props.lineEnding === "\r\n" ? "CRLF" : "LF"}`}
          className={trigger}
          disabled={props.readOnly}
        >
          {props.lineEnding === "\r\n" ? "CRLF" : "LF"}
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
      <span className="px-1.5">UTF-8</span>
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
