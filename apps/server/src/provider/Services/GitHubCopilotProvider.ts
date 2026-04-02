import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface GitHubCopilotProviderShape extends ServerProviderShape {}

export class GitHubCopilotProvider extends ServiceMap.Service<
  GitHubCopilotProvider,
  GitHubCopilotProviderShape
>()("t3/provider/Services/GitHubCopilotProvider") {}
