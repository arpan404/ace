import SwiftUI

/// The machines the inbox can't reach right now, as the header names them. Built from each
/// session's own connection state; the rows keep their own confirmation and never read fresh.
struct InboxConnectionProblem: Equatable {
    /// The machine's name when one is out, else how many.
    let text: String
    /// Still trying (spinner) rather than out of reach.
    let trying: Bool
    /// `inbox.connection.<name>` when machines are named, for UI tests.
    let identifier: String

    @MainActor static func of(_ inbox: MachineInbox) -> InboxConnectionProblem? {
        let out = inbox.sessions.filter { $0.client.connection != "ready" }
        guard let first = out.first else { return nil }
        let trying = out.allSatisfy { ["connecting", "starting", "reconnecting"].contains($0.client.connection) }
        let named = inbox.showsMachineNames ? inbox.name(first.hostId) : "your machine"
        let subject = out.count > 1 ? "\(out.count) machines" : named
        let fatal = out.contains { $0.client.connection == "fatal" }
        let text = fatal ? "Can't reach \(subject)"
            : out.allSatisfy({ ["connecting", "starting"].contains($0.client.connection) }) ? "Connecting to \(subject)"
            : trying ? "Reconnecting to \(subject)"
            : out.count > 1 ? "\(subject) offline" : inbox.showsMachineNames ? "\(named) is offline" : "Your machine is offline"
        let identifier = inbox.showsMachineNames && out.count == 1 ? "inbox.connection.\(inbox.name(first.hostId))" : "inbox.connection"
        return InboxConnectionProblem(text: text, trying: trying && !fatal, identifier: identifier)
    }
}

/// The inbox's leading title: the "ace" wordmark, or, once a connection problem has lasted
/// 800ms, what is wrong in its place. Tapping the problem opens Machines.
struct InboxTitle: View {
    let problem: InboxConnectionProblem?
    let openMachines: () -> Void
    @State private var shown: InboxConnectionProblem?

    var body: some View {
        Group {
            if let shown {
                Button(action: openMachines) {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        if shown.trying { ProgressView().controlSize(.small) } else { AceIcon(.wifiSlash, size: 16, relativeTo: .subheadline) }
                        Text(shown.text).lineLimit(1)
                    }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize()
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens Machines")
                .accessibilityIdentifier(shown.identifier)
            } else {
                Text("ace")
                    .aceFont(AceTheme.Typography.title, relativeTo: .title3)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .fixedSize()
                    .accessibilityHidden(true)
            }
        }
        .task(id: problem) {
            guard let problem else { shown = nil; return }
            // An already-visible problem updates at once; a new one waits out a brief blip.
            if shown == nil { try? await Task.sleep(for: .milliseconds(800)) }
            if !Task.isCancelled { shown = problem }
        }
    }
}

/// Which threads the list shows: "All projects ⌄" at the foot of the screen, one native menu
/// with every scope. Pull requests in review are a scope of the same list, not a page; the
/// machine choice shows only while more than one is paired.
struct InboxScopeMenu: View {
    let inbox: MachineInbox
    @Binding var scope: InboxScope

    private struct Choice: Hashable { let id: String; let name: String }
    private var projects: [Choice] {
        var seen = Set<String>()
        return inbox.sessions.filter { scope.machine.isEmpty || $0.hostId == scope.machine }.flatMap { $0.client.inbox.values }.compactMap { row in
            guard let id = row.workspaceId, seen.insert(id).inserted else { return nil }
            return Choice(id: id, name: row.project)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    /// "All projects", "billing-api", "Pulls · billing-api", "Mac mini · All projects".
    private var title: String {
        let project = projects.first { $0.id == scope.project }?.name
        let parts = [scope.machine.isEmpty ? nil : inbox.name(scope.machine),
                     scope.pulls ? "Pulls" : nil,
                     project ?? (scope.pulls ? nil : "All projects")]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Menu {
            Picker("Show", selection: $scope.pulls) {
                Label("Threads", ace: .chatText).tag(false)
                Label("Pull requests in review", ace: .gitPullRequest).tag(true)
            }
            .pickerStyle(.inline)
            if inbox.showsMachineNames {
                Picker(selection: $scope.machine) {
                    Text("All machines").tag("")
                    ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                } label: { Label("Machine", ace: .desktop) }
                .pickerStyle(.menu)
                .accessibilityIdentifier("inbox.machines.filter")
            }
            Picker(selection: $scope.project) {
                Text("All projects").tag("")
                ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
            } label: { Label("Project", ace: .folder) }
            .pickerStyle(.menu)
        } label: {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(title).lineLimit(1)
                AceIcon(.caretDown, size: 12, weight: .bold, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(title)
        .accessibilityHint("Chooses which threads show")
        .accessibilityIdentifier("inbox.projects")
    }
}

/// What the list shows: every thread or only those with a pull request in review, on one
/// machine or all, in one project or all.
struct InboxScope: Equatable {
    var pulls = false
    var machine = ""
    var project = ""
}
