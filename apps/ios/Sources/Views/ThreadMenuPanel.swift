import SwiftUI

/// One of the thread's screens in the ⋯ panel's icon grid.
private struct MenuScreen: Identifiable {
    let id: String
    let title: String
    let icon: AceIcon.Name
    let destination: ThreadDestination
    var identifier: String { id }
}

/// The four primary destinations, always one tap away.
private struct MenuScreenGrid: View {
    let open: (ThreadDestination) -> Void
    let dismiss: DismissAction
    @Environment(\.dynamicTypeSize) private var typeSize

    private var screens: [MenuScreen] {
        [
            MenuScreen(id: "thread.changes", title: "Changes", icon: .plusMinus, destination: .changes),
            MenuScreen(id: "thread.files", title: "Files", icon: .folder, destination: .files),
            MenuScreen(id: "thread.terminal", title: "Terminal", icon: .terminalWindow, destination: .terminal),
            MenuScreen(id: "thread.browser", title: "Browser", icon: .compass, destination: .browser),
        ]
    }

    var body: some View {
        // Large text gets two columns so labels never clip; otherwise four across.
        let columns = Array(repeating: GridItem(.flexible(), spacing: AceTheme.Spacing.xs),
                            count: typeSize.isAccessibilitySize ? 2 : 4)
        LazyVGrid(columns: columns, spacing: AceTheme.Spacing.sm) {
            ForEach(screens) { screen in
                Button {
                    open(screen.destination)
                    dismiss()
                } label: {
                    VStack(spacing: AceTheme.Spacing.xxs) {
                        AceIcon(screen.icon, size: 20, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .frame(height: AceTheme.Spacing.xl)
                        Text(screen.title)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(screen.id == "thread.search" ? "Find in thread" : screen.title)
                .accessibilityIdentifier(screen.id)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open a screen")
    }
}

/// One compact row in the ⋯ panel's action sections.
private struct MenuRow: View {
    let title: String
    let icon: AceIcon.Name
    var identifier: String? = nil
    var role: ButtonRole? = nil
    let action: () -> Void
    var body: some View {
        Button(role: role, action: action) {
            Label(title, ace: icon)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(role == .destructive ? Color.red : AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier ?? title)
    }
}

/// A compact sheet of primary destinations and native menus for secondary actions.
struct ThreadMenuPanel: View {
    let model: ClientModel
    let thread: ThreadModel
    var title = ""
    let archived: Bool
    let hasActivity: Bool
    let activityRow: () -> ThreadRow?
    let open: (ThreadDestination) -> Void
    let problem: (String) -> Void
    let leave: () -> Void
    @Environment(\.threadOrganizer) private var organizer
    @Environment(\.dismiss) private var dismiss
    private var row: ThreadRow? { model.inbox[thread.id] }
    private func leaving(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        ThreadOrganizer(perform: { key, id in
                            organizer.perform(key, id)
                            if id == "archive" { leave() }
                        },
                        snooze: { key, preset in organizer.snooze(key, preset); leave() },
                        wake: organizer.wake)
    }

    var body: some View {
        ScrollView { panel }
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityIdentifier("thread.options.scroll")
            .frame(idealWidth: 340, maxWidth: 380)
            .accessibilityLabel("Thread options")
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            MenuScreenGrid(open: open, dismiss: dismiss)
                .padding(.bottom, AceTheme.Spacing.sm)
            Divider()
            Menu { conversation } label: { groupLabel("Conversation", icon: .notePencil) }
                .accessibilityIdentifier("thread.options.conversation")
                .menuIndicator(.hidden)
            Menu { tools } label: { groupLabel("Tools", icon: .wrench) }
                .accessibilityIdentifier("thread.options.tools")
                .menuIndicator(.hidden)
            Menu {
                if let organizer, let row, let hostId = model.hostId, model.canOperate {
                    ThreadActionItems(key: InboxKey(machineId: hostId, id: thread.id), row: row,
                                      labels: model.inboxLayout.menuLabels ?? [:],
                                      sections: model.inboxLayout.menuSections ?? [:],
                                      snoozeOptions: model.inboxLayout.snooze,
                                      organizer: dismissing(leaving(organizer)))
                    Divider()
                }
                system
            } label: { groupLabel("Organize", icon: .folderSimple) }
                .accessibilityIdentifier("thread.options.organize")
                .menuIndicator(.hidden)
            if model.canOperate, thread.screen.controls?.canStop == true {
                Divider()
                MenuRow(title: "Stop all agents", icon: .stopCircle) {
                    model.stopTree(); dismiss()
                }
                .disabled(thread.screen.stopping)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.md)
    }

    private func groupLabel(_ title: String, icon: AceIcon.Name) -> some View {
        HStack {
            Label(title, ace: icon)
            Spacer(minLength: AceTheme.Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .aceFont(AceTheme.Typography.body, relativeTo: .body)
        .foregroundStyle(AceTheme.Colours.foreground)
        .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// What can be done with the conversation itself.
    @ViewBuilder private var conversation: some View {
        MenuRow(title: "Find in thread", icon: .magnifyingGlass, identifier: "thread.search") { open(.search); dismiss() }
        MenuRow(title: "Turns", icon: .listBullets, identifier: "thread.turns") { open(.turns); dismiss() }
        MenuRow(title: "Attachments", icon: .paperclip, identifier: "thread.attachments") { open(.attachments); dismiss() }
        if model.canOperate, !archived {
            Divider()
            MenuRow(title: "Rename…", icon: .pencilSimple, identifier: "thread.menu.rename") {
                open(.rename); dismiss()
            }
            if thread.screen.transitions?.lastTurn == true {
                MenuRow(title: "Fork from the last turn", icon: .gitFork, identifier: "thread.forkLast") {
                    open(.forkLast); dismiss()
                }
            }
            if thread.screen.transitions?.parent != nil {
                MenuRow(title: "Bring back to parent…", icon: .gitMerge, identifier: "thread.merge") {
                    open(.merge); dismiss()
                }
            }
        }
    }

    /// The thread's tools that aren't screens: what the phone keeps, runs and opens elsewhere.
    @ViewBuilder private var tools: some View {
        MenuRow(title: "Agent tree", icon: .treeStructure, identifier: "thread.agents") { open(.agents); dismiss() }
        MenuRow(title: "Logs", icon: .scroll, identifier: "thread.logs") { open(.logs); dismiss() }
        if let run = thread.screen.offshift {
            MenuRow(title: "Offshift run · \(run.word)", icon: .listChecks, identifier: "thread.offshift") { open(.offshift); dismiss() }
        }
        Divider()
        MenuRow(title: "Reload from machine", icon: .arrowClockwise, identifier: "thread.reload") {
            model.reloadFromMachine(); dismiss()
        }
        MenuRow(title: "Run and preview…", icon: .play, identifier: "thread.scripts") {
            open(.scripts); dismiss()
        }
        MenuRow(title: "Work", icon: .gitBranch, identifier: "thread.work") {
            open(.work); dismiss()
        }
        MenuRow(title: "Devices", icon: .deviceMobile, identifier: "thread.devices") {
            open(.devices); dismiss()
        }
        MenuRow(title: "Computer use", icon: .appWindow, identifier: "thread.computer") {
            open(.computer); dismiss()
        }
        MenuRow(title: "Skills and tools", icon: .wrench, identifier: "thread.tools") {
            open(.tools); dismiss()
        }
        OpenOnHostMenu(model: model, target: HostOpenTarget(threadId: thread.id)) {
            Label("Open in…", ace: .arrowSquareOut)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier("thread.openIn")
    }

    /// Continue on, Lock Screen, and the organize fallbacks when no row is held.
    @ViewBuilder private var system: some View {
        if model.canOperate, model.transfers.linked, !archived {
            let ready = model.transfers.thread(thread.id)?.canContinue == true
            Button {
                model.continueOn(threadId: thread.id, title: title); dismiss()
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text("Continue on…")
                        if !ready {
                            Text("Available once the thread stops working")
                                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } icon: { Image(ace: .desktop) }
            }
            .disabled(!ready)
            .accessibilityIdentifier("thread.continueOn")
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
        }
        if hasActivity, let hostId = model.hostId {
            MenuRow(title: "Show on Lock Screen", icon: .squaresFour) {
                guard let activityRow = activityRow() else { return }
                do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                catch { problem(error.localizedDescription) }
                dismiss()
            }
        }
        if organizer == nil || row == nil {
            if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                Menu {
                    ForEach(model.inboxLayout.snooze) { option in
                        Button(option.label) {
                            Task { if await model.snooze(thread.id, preset: option.id) { leave() } }
                            dismiss()
                        }
                    }
                } label: {
                    Label("Snooze", ace: .bellSimpleZ)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .contentShape(Rectangle())
                }
            }
            if model.canOperate, !archived {
                MenuRow(title: "Archive", icon: .archive) {
                    Task { if await model.archive(thread.id) { leave() } }
                    dismiss()
                }
            }
        }
    }

    /// Organize actions dismiss the panel after they run, as a Menu does.
    private func dismissing(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        let dismiss = dismiss
        return ThreadOrganizer(perform: { key, id in organizer.perform(key, id); dismiss() },
                               snooze: { key, preset in organizer.snooze(key, preset); dismiss() },
                               wake: { organizer.wake($0); dismiss() })
    }
}
