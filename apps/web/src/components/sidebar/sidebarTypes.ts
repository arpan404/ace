import { ProjectId, ThreadId } from "@ace/contracts";

import type { RemoteHostInstance } from "../../lib/remoteHosts";
import type { Project } from "../../types";

export interface RemoteSidebarThreadEntry {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface RemoteSidebarProjectEntry {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly icon: Project["icon"];
  readonly defaultModelSelection: Project["defaultModelSelection"];
  readonly threads: ReadonlyArray<RemoteSidebarThreadEntry>;
}

export interface RemoteSidebarHostEntry {
  readonly host: RemoteHostInstance;
  readonly connectionUrl: string;
  readonly status: "loading" | "available" | "unavailable";
  readonly projects: ReadonlyArray<RemoteSidebarProjectEntry>;
  readonly error?: string;
}

export interface CombinedSidebarSnapshotProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
  readonly updatedAt: string;
  readonly icon: Project["icon"];
  readonly defaultModelSelection: Project["defaultModelSelection"];
  readonly connectionUrl: string;
  readonly threads: ReadonlyArray<RemoteSidebarThreadEntry>;
}

export interface CombinedSidebarSnapshotThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly connectionUrl: string;
}

export interface CombinedSidebarSnapshot {
  readonly projects: ReadonlyArray<CombinedSidebarSnapshotProject>;
  readonly threads: ReadonlyArray<CombinedSidebarSnapshotThread>;
}

export type SearchPaletteMode = "root" | "new-thread-project";

export type SearchPaletteItem =
  | {
      id: string;
      type: "action.new-thread";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "action.new-project";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "action.open-settings";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "project";
      projectId: ProjectId;
      label: string;
      description: string;
      connectionUrl?: string;
    }
  | {
      id: string;
      type: "thread";
      threadId: ThreadId;
      label: string;
      description: string;
      connectionUrl?: string;
    };
