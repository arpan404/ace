import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination { case changes, search, files, terminal, browser, devices, computer, tools, agents }

/// The thread's header, quiet like the web's: the native back, the title with its project under
/// it, then ⋯. Agents are secondary: the agent tree is one entry in ⋯, never its own control.
struct ThreadToolbar: ToolbarContent {
    let title: String
    let project: String
    /// The project's two-letter tag, as the task list draws it.
    let badge: String?
    let status: StatusDisplay?
    let menu: ThreadMenu

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .principal) { heading }.sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { menu }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { heading }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
    }
    private var heading: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Text(title).aceFont(AceTheme.Typography.label, relativeTo: .headline)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if !project.isEmpty {
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    if let badge, !badge.isEmpty { ProjectTag(initials: badge) }
                    Text(project).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: AceTheme.Dimensions.touchTarget * 5)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(status?.label ?? "")
        .accessibilityIdentifier("thread.title")
    }
}

/// The ⋯ menu: the thread's other places and what can be done to it.
struct ThreadMenu: View {
    let model: ClientModel
    let thread: ThreadModel
    let archived: Bool
    /// The row a Lock Screen activity starts from; nil when there is none yet.
    let activityRow: ThreadRow?
    let open: (ThreadDestination) -> Void
    let problem: (String) -> Void
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void

    var body: some View {
        Menu {
            Section {
                Button("Changes", ace: .plusMinus) { open(.changes) }.accessibilityIdentifier("thread.changes")
                Button("Agent tree", ace: .treeStructure) { open(.agents) }.accessibilityIdentifier("thread.agents")
                Button("Find in thread", ace: .magnifyingGlass) { open(.search) }.accessibilityIdentifier("thread.search")
                Button("Files", ace: .folder) { open(.files) }.accessibilityIdentifier("thread.files")
                Button("Browser", ace: .compass) { open(.browser) }.accessibilityIdentifier("thread.browser")
                Button("Devices", ace: .deviceMobile) { open(.devices) }.accessibilityIdentifier("thread.devices")
                Button("Terminal", ace: .terminalWindow) { open(.terminal) }.accessibilityIdentifier("thread.terminal")
                Button("Computer use", ace: .appWindow) { open(.computer) }
                Button("Skills and tools", ace: .wrench) { open(.tools) }.accessibilityIdentifier("thread.tools")
            }
            Section {
                if let activityRow, let hostId = model.hostId {
                    Button("Show on Lock Screen", ace: .squaresFour) {
                        do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                        catch { problem(error.localizedDescription) }
                    }
                }
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
            if model.canOperate, thread.screen.controls?.canStop == true {
                Section {
                    // Stop isn't destructive: it reads in ink, never red.
                    Button("Stop all agents", ace: .stopCircle) { model.stopTree() }
                        .disabled(thread.screen.stopping)
                }
            }
        } label: {
            AceIcon(.dotsThree, size: 20)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
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
