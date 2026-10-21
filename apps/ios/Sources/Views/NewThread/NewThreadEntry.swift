import SwiftUI

/// The inbox header's compose button and what follows a start: once the machine's receipt names
/// the new thread and its row arrives, the thread opens. Offline, the start waits in Unsent.
struct NewThreadEntry: ViewModifier {
    @Bindable var inbox: MachineInbox
    let open: (InboxKey) -> Void
    @Binding var projectFilter: String
    @State private var composing = false
    @State private var awaiting: (machineId: String, commandId: String)?
    /// Starting is impossible when every paired machine is view-only: both entries stay
    /// out rather than opening a sheet whose Start can never enable.
    private var canStart: Bool {
        inbox.sessions.isEmpty || inbox.sessions.contains(where: { $0.client.canOperate })
    }

    private struct ProjectChoice { let id: String; let name: String }
    private var projects: [ProjectChoice] {
        var seen = Set<String>()
        return inbox.sessions.flatMap { $0.client.inbox.values }.compactMap { row in
            guard let id = row.workspaceId, seen.insert(id).inserted else { return nil }
            return ProjectChoice(id: id, name: row.project)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Menu {
                        Button("All projects") { projectFilter = "" }
                        ForEach(projects, id: \.id) { project in
                            Button(project.name) { projectFilter = project.id }
                        }
                    } label: {
                        HStack(spacing: AceTheme.Spacing.xs) {
                            Text(projects.first { $0.id == projectFilter }?.name ?? "All projects").lineLimit(1)
                            Image(systemName: "chevron.down")
                        }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    }
                    .accessibilityIdentifier("inbox.projects")
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if canStart {
                        Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                            .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                            .disabled(inbox.sessions.isEmpty)
                            .accessibilityLabel("New thread").accessibilityIdentifier("inbox.startTask")
                    }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.horizontal, AceTheme.Spacing.lg)
                .background(AceTheme.Colours.background)
            }
            .sheet(isPresented: $composing) {
                NewThreadSheet(inbox: inbox, saved: { machineId, commandId in awaiting = (machineId, commandId) }, initialProject: projectFilter.isEmpty ? nil : projectFilter)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .task(id: awaiting?.commandId) {
                guard let awaiting, let client = inbox.client(awaiting.machineId) else { return }
                // A minute covers a slow worktree; after that the row is in the inbox to tap.
                for _ in 0..<600 {
                    if let outcome = client.compose.started[awaiting.commandId] {
                        guard outcome.ok, let threadId = outcome.id else { break }
                        if client.inbox[threadId] != nil {
                            open(InboxKey(machineId: awaiting.machineId, id: threadId))
                            break
                        }
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                    if Task.isCancelled { return }
                }
                self.awaiting = nil
            }
    }
}

extension View {
    func newThreadEntry(inbox: MachineInbox, projectFilter: Binding<String>, open: @escaping (InboxKey) -> Void) -> some View {
        modifier(NewThreadEntry(inbox: inbox, open: open, projectFilter: projectFilter))
    }
}
