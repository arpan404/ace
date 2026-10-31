/** Explain the effect of a control; pages can replace this with a current-state explanation. */
export const settingDescriptions: Readonly<Partial<Record<string, string>>> = {
  "profile.name": "Shown beside your messages. Saved when you leave this field or press Enter.",
  "providers.default":
    "The provider new threads start with. You can choose another in each thread.",
  "terminals.openIn": "Where terminal tabs open in this window.",
  "editor.default": "The editor used when you open a project or file from ace.",
  "threads.useWorktree":
    "Start new threads in separate Git worktrees so their changes stay isolated.",
  "threads.forkOnSwitch":
    "Create a new thread when changing providers. The original conversation stays unchanged.",
  "threads.settleOnMerge":
    "Move a thread out of the active list when its linked pull request is merged.",
  "threads.settleOnClose":
    "Move a thread out of the active list when its linked pull request is closed without merging.",
  "generation.model": "The model ace uses for titles and other generated text.",
  "generation.autoDraftCommits": "Generate a draft commit message from your changes.",
  "automations.enabled": "Allow scheduled automations to run on this machine.",
  "app.openAtLogin": "Start the desktop app when you sign in to your computer.",
  "app.background": "Keep ace running after you close its windows.",
  "app.preventSleep": "Keep this computer awake while agents are working.",
  "appearance.mode": "Use a light or dark interface, or follow your system.",
  "appearance.theme": "Choose the interface colors.",
  "appearance.accent": "Choose the color used for selected controls.",
  "appearance.translucency": "Adjust how much shows through floating menus and the composer.",
  "appearance.reduceMotion":
    "Reduce movement in interface animations. System follows your device preference.",
  "appearance.transcriptSize": "Change the text size in conversations.",
  "browser.profile": "Choose whether new browsers keep sign-ins and cookies or start fresh.",
  "browser.loss": "Choose what happens to browser sessions when the desktop app disconnects.",
  "browser.revealAgentPages": "Bring pages opened by agents into view automatically.",
};
