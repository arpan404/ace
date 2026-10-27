import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination { case work, changes, search, files, terminal, scripts, browser, devices, computer, tools, agents, rename, forkLast, merge, turns, attachments }

/// The thread's header: the native back over a pushed page, or at the open thread's root the
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`), the title centred
/// with a small "project · branch" line under it (a button that opens Work), then ⋯. Agents are secondary: the agent tree is one entry in ⋯, never its own control.
struct ThreadToolbar: ToolbarContent {
    let title: String
    /// "project · branch" (or the machine where there is no branch).
    let subtitle: String
    let status: StatusDisplay?
    /// Rename and name-again from the title's own menu; nil where the thread can't be renamed.
    var rename: (() -> Void)? = nil
    var retitle: (() -> Void)? = nil
    let menu: ThreadMenu
    /// Opens the thread's Work sheet from the "project · branch" line.
    let openWork: () -> Void

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .principal) { heading }.sharedBackgroundVisibility(.hidden)
            // ⋯ sits in the same glass circle as the system's back button across from it.
            ToolbarItem(placement: .topBarTrailing) { menu }
        } else {
            ToolbarItem(placement: .principal) { heading }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
    }
    /// The title opens its own menu, Rename first, as the system's documents do; a small chevron
    /// beside it says so. The "project · branch" line under it opens Work.
    private var heading: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            titleRow
            if !subtitle.isEmpty {
                // The checkout's line opens Work: where the thread runs and what can move it.
                Button(action: openWork) {
                    Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                        .frame(minHeight: AceTheme.Spacing.lg).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(subtitle)
                .accessibilityHint("Opens Work")
                .accessibilityIdentifier("thread.subtitle")
            }
        }
        .frame(maxWidth: AceTheme.Dimensions.touchTarget * 5)
        .accessibilityElement(children: .contain)
    }
    @ViewBuilder private var titleRow: some View {
        if let rename {
            Menu {
                Button("Rename…", ace: .pencilSimple, action: rename).accessibilityIdentifier("thread.rename")
                if let retitle { Button("Name from first message", ace: .sparkle, action: retitle).accessibilityIdentifier("thread.retitle") }
            } label: { titleText(chevron: true) }
            .accessibilityIdentifier("thread.title")
            .accessibilityHint("Rename this thread")
        } else {
            titleText(chevron: false).accessibilityIdentifier("thread.title")
        }
    }
    private func titleText(chevron: Bool) -> some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            Text(title).aceFont(AceTheme.Typography.body, relativeTo: .headline).fontWeight(.semibold)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if chevron {
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    .foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(status?.label ?? "")
    }
}

struct ThreadMenu: View {
    let model: ClientModel
    let thread: ThreadModel
    /// The thread's title, as Continue on… names it.
    var title = ""
    let archived: Bool
    /// The row a Lock Screen activity starts from; nil when there is none yet.
    let activityRow: ThreadRow?
    let open: (ThreadDestination) -> Void
    let problem: (String) -> Void
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void
    @Environment(\.threadOrganizer) private var organizer
    /// The thread's inbox row, whose shared menu ids the organize actions follow.
    private var row: ThreadRow? { model.inbox[thread.id] }
    /// Snoozing or archiving the open thread takes the person back to the list.
    private func leaving(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        ThreadOrganizer(perform: { key, id in
                            organizer.perform(key, id)
                            if id == "archive" { leave() }
                        },
                        snooze: { key, preset in organizer.snooze(key, preset); leave() },
                        wake: organizer.wake)
    }

    var body: some View {
        Menu {
            Section {
                Button("Changes", ace: .plusMinus) { open(.changes) }.accessibilityIdentifier("thread.changes")
                Button("Agent tree", ace: .treeStructure) { open(.agents) }.accessibilityIdentifier("thread.agents")
                Button("Find in thread", ace: .magnifyingGlass) { open(.search) }.accessibilityIdentifier("thread.search")
                Button("Turns", ace: .listBullets) { open(.turns) }.accessibilityIdentifier("thread.turns")
            }
            // What can be done with the conversation itself.
            Section {
                if model.canOperate, !archived {
                    Button("Rename…", ace: .pencilSimple) { open(.rename) }.accessibilityIdentifier("thread.menu.rename")
                    if thread.screen.transitions?.lastTurn == true {
                        Button("Fork from the last turn", ace: .gitFork) { open(.forkLast) }.accessibilityIdentifier("thread.forkLast")
                    }
                    if thread.screen.transitions?.parent != nil {
                        Button("Bring back to parent…", ace: .gitMerge) { open(.merge) }.accessibilityIdentifier("thread.merge")
                    }
                }
                Button("Run and preview…", ace: .play) { open(.scripts) }.accessibilityIdentifier("thread.scripts")
                Button("Work", ace: .gitBranch) { open(.work) }.accessibilityIdentifier("thread.work")
            }
            // Everything the thread's row offers, in the same words and order (`threadMenu`).
            if let organizer, let row, let hostId = model.hostId, model.canOperate {
                ThreadActionItems(key: InboxKey(machineId: hostId, id: thread.id), row: row,
                                  labels: model.inboxLayout.menuLabels ?? [:], sections: model.inboxLayout.menuSections ?? [:],
                                  snoozeOptions: model.inboxLayout.snooze, organizer: leaving(organizer))
            }
            Section {
                Button("Files", ace: .folder) { open(.files) }.accessibilityIdentifier("thread.files")
                Button("Attachments", ace: .paperclip) { open(.attachments) }.accessibilityIdentifier("thread.attachments")
                Button("Browser", ace: .compass) { open(.browser) }.accessibilityIdentifier("thread.browser")
                Button("Devices", ace: .deviceMobile) { open(.devices) }.accessibilityIdentifier("thread.devices")
                Button("Terminal", ace: .terminalWindow) { open(.terminal) }.accessibilityIdentifier("thread.terminal")
                OpenOnHostMenu(model: model, target: HostOpenTarget(threadId: thread.id)) { Label("Open in…", ace: .arrowSquareOut) }
                    .accessibilityIdentifier("thread.openIn")
                Button("Computer use", ace: .appWindow) { open(.computer) }
                Button("Skills and tools", ace: .wrench) { open(.tools) }.accessibilityIdentifier("thread.tools")
            }
            Section {
                if model.canOperate, model.transfers.linked, !archived {
                    // Shown only while this machine links to another (ADR 0101).
                    let ready = model.transfers.thread(thread.id)?.canContinue == true
                    Button { model.continueOn(threadId: thread.id, title: title) } label: {
                        Label {
                            Text("Continue on…")
                            if !ready { Text("Available once the thread stops working") }
                        } icon: { Image(ace: .desktop) }
                    }
                    .disabled(!ready)
                    .accessibilityIdentifier("thread.continueOn")
                }
                if let activityRow, let hostId = model.hostId {
                    Button("Show on Lock Screen", ace: .squaresFour) {
                        do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                        catch { problem(error.localizedDescription) }
                    }
                }
                if organizer == nil || row == nil {
                    if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                        Menu {
                            ForEach(model.inboxLayout.snooze) { option in
                                Button(option.label) { Task { if await model.snooze(thread.id, preset: option.id) { leave() } } }
                            }
                        } label: { Label("Snooze", ace: .bellSimpleZ) }
                    }
                    if model.canOperate, !archived {
                        Button("Archive", ace: .archive) { Task { if await model.archive(thread.id) { leave() } } }
                    }
                }
            }
            Section {
                // Drops what the phone keeps of this thread and reads it again from the machine.
                Button("Reload from machine", ace: .arrowClockwise) { model.reloadFromMachine() }
                    .accessibilityIdentifier("thread.reload")
            }
            if model.canOperate, thread.screen.controls?.canStop == true {
                Section {
                    // Stop isn't destructive: it reads in ink, never red.
                    Button("Stop all agents", ace: .stopCircle) { model.stopTree() }
                        .disabled(thread.screen.stopping)
                }
            }
        } label: {
            AceIcon(.dotsThree, size: 20)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm, height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
        }
        // On the menu itself: a label on its icon leaves the button VoiceOver reads unnamed.
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
    }
}

extension View {
    /// The thread's title and its "project · branch" line, as the system draws them on iOS 26.
    @ViewBuilder func threadTitle(_ title: String, subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationTitle(title).navigationSubtitle(subtitle)
        } else {
            navigationTitle(title)
        }
    }
}
