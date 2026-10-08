import { hasDesktopPreferences } from "@/boot/desktop-settings.ts";
import {
  BellSimpleIcon,
  BrowserIcon,
  CursorClickIcon,
  DeviceMobileIcon,
  FilesIcon,
  GitPullRequestIcon,
  GlobeSimpleIcon,
  PlusIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { Fade, RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

/**
 * A group of tools ace gives this thread's agents (the ace MCP server's capability groups), and
 * where a person sees or changes it: a tab of the side panel, or a Settings page.
 */
interface ToolSource {
  id: string;
  label: string;
  detail: string;
  icon: PhosphorIcon;
  /** The side panel tool showing what the agents do with it. */
  kind?: string;
  /** The page that turns it on or off. */
  page?: "/settings/computer-use" | "/settings/notifications";
}

const toolSources: readonly ToolSource[] = [
  {
    id: "browser",
    label: "Browser",
    detail: "Open and drive web pages",
    icon: GlobeSimpleIcon,
    kind: "browser",
  },
  {
    id: "files",
    label: "Files",
    detail: "Read and edit the checkout",
    icon: FilesIcon,
    kind: "files",
  },
  {
    id: "terminal",
    label: "Terminal",
    detail: "Run commands and dev servers",
    icon: TerminalWindowIcon,
    kind: "terminal",
  },
  {
    id: "screen",
    label: "Computer use",
    detail: "Other apps, in the background",
    icon: CursorClickIcon,
    page: "/settings/computer-use",
  },
  {
    id: "devices",
    label: "Devices",
    detail: "Simulators and emulators",
    icon: DeviceMobileIcon,
    kind: "devices",
  },
  {
    id: "preview",
    label: "Preview",
    detail: "The project's dev server",
    icon: BrowserIcon,
    kind: "preview",
  },
  {
    id: "agents",
    label: "Subagents",
    detail: "Start and steer other agents",
    icon: TreeStructureIcon,
    kind: "agents",
  },
  {
    id: "forge",
    label: "GitHub and GitLab",
    detail: "Pull requests for this branch",
    icon: GitPullRequestIcon,
  },
  {
    id: "notify",
    label: "Notifications",
    detail: "Tell you when something needs you",
    icon: BellSimpleIcon,
    page: "/settings/notifications",
  },
];

/** Rows before View all. */
const firstFew = 4;

/**
 * Sources: the tools ace gives this thread's agents, each opening where it is seen or turned on
 * (Computer use and Notifications in Settings, the rest as side panel tabs). + adds a plugin or
 * MCP server in Skills. The providers' own MCP servers aren't listed: the daemon doesn't report
 * them to clients yet.
 */
export function SourcesSection(props: { thread: ThreadRef; onClose(): void }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const available = toolSources.filter(
    (source) => source.id !== "notify" || hasDesktopPreferences(),
  );
  const shown = all ? available : available.slice(0, firstFew);
  const open = (source: ToolSource) => {
    if (source.kind) workspace.open({ kind: source.kind });
    else if (source.page) void navigate({ to: source.page });
    props.onClose();
  };
  return (
    <section aria-labelledby="work-card-sources">
      <SectionHead id="work-card-sources" title="Sources">
        <IconButton
          icon={PlusIcon}
          label="Add a plugin or MCP server"
          size="sm"
          className="size-7"
          onClick={() => {
            void navigate({ to: "/skills" });
            props.onClose();
          }}
        />
      </SectionHead>
      <ul aria-label="Tool sources" className="flex flex-col">
        {shown.map((source) => (
          <li key={source.id}>
            {source.kind || source.page ? (
              <RowButton
                aria-label={`${source.label}: ${source.detail}`}
                onClick={() => open(source)}
              >
                <SourceBody source={source} />
              </RowButton>
            ) : (
              <RowNote className="text-foreground">
                <SourceBody source={source} />
              </RowNote>
            )}
          </li>
        ))}
      </ul>
      <RowButton aria-expanded={all} className="text-muted-foreground" onClick={() => setAll(!all)}>
        <span aria-hidden className="size-4 shrink-0" />
        {all ? "Show fewer" : "View all"}
      </RowButton>
    </section>
  );
}

function SourceBody(props: { source: ToolSource }) {
  const Glyph = props.source.icon;
  return (
    <>
      <Glyph aria-hidden size={16} className={rowIcon} />
      <span className="shrink-0">{props.source.label}</span>
      <Fade className="text-subtle-foreground">{props.source.detail}</Fade>
    </>
  );
}
