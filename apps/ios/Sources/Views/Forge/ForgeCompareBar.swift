import SwiftUI

/// The top of Files changed: which commits it shows (All commits, one commit, or what changed
/// between two) with Change to pick others, and how many files are viewed.
struct ForgeCompareBar: View {
    let label: String
    /// "2 of 5 viewed", where GitHub's marks apply.
    let viewed: String?
    let change: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    .contentTransition(.opacity)
                    .accessibilityIdentifier("forge.files.range")
                if let viewed { Text(viewed).meta().monospacedDigit().contentTransition(.numericText()) }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Button("Change", action: change)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .frame(minHeight: 44)
                .accessibilityLabel("Change which commits are shown")
                .accessibilityIdentifier("forge.files.change")
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
    }
}

/// The sheet Change opens: All commits, any one commit, or two commits to compare.
struct ForgeRangeSheet: View {
    let client: ClientModel
    let route: ForgeRoute
    let current: ForgeRange?
    let pick: (ForgeRange?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var list: ForgeCommits?
    @State private var failure: String?

    init(client: ClientModel, route: ForgeRoute, current: ForgeRange?, pick: @escaping (ForgeRange?) -> Void) {
        self.client = client
        self.route = route
        self.current = current
        self.pick = pick
        _list = State(initialValue: client.kept(ClientModel.forgeCommitsRead(project: route.project, number: route.number, repository: route.repository), as: ForgeCommits.self))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let list {
                    ForgeCommitPicker(commits: list.commits, truncated: list.truncated, current: current, all: { choose(nil) },
                                      sinceReview: list.sinceReview) { choose($0) }
                        .padding(.vertical, AceTheme.Spacing.md)
                        .transition(.opacity)
                } else if let failure {
                    EmptyState(icon: nil, title: "Couldn't load the commits", line: failure, failed: true) {
                        Button("Try again") { Task { await load() } }
                    }
                    .padding(.top, 80)
                } else {
                    ProgressView().padding(.top, 80).frame(maxWidth: .infinity)
                }
            }
            .animation(.smooth, value: list == nil)
            .background(AceTheme.Colours.background)
            .navigationTitle("Show changes from")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func choose(_ range: ForgeRange?) {
        pick(range)
        dismiss()
    }

    private func load() async {
        do { list = try await client.forgeCommits(project: route.project, number: route.number, repository: route.repository); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}
