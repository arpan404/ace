import SwiftUI

/// A pull request's commits, oldest first as GitHub lists them. A commit opens its own files;
/// Compare two commits picks a commit to start after and a later one to end at, and opens what
/// changed between them.
struct ForgeCommitsView: View {
    let client: ClientModel
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    @State private var list: ForgeCommits?
    @State private var failure: String?
    private var request: [String: Any] { ClientModel.forgeCommitsRead(project: route.project, number: route.number, repository: route.repository) }

    init(client: ClientModel, route: ForgeRoute, open: @escaping (ForgeRoute) -> Void) {
        self.client = client
        self.route = route
        self.open = open
        _list = State(initialValue: client.kept(ClientModel.forgeCommitsRead(project: route.project, number: route.number, repository: route.repository), as: ForgeCommits.self))
    }

    var body: some View {
        ScrollView {
            if let list {
                ForgeCommitPicker(commits: list.commits, truncated: list.truncated) { range in
                    open(ForgeRoute(kind: .files, machineId: route.machineId, project: route.project, number: route.number,
                                    repository: route.repository, range: range))
                }
                .padding(.vertical, AceTheme.Spacing.md)
                .transition(.opacity)
            } else if let failure {
                EmptyState(icon: nil, title: "Couldn't load the commits", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .animation(.smooth, value: list == nil)
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .navigationTitle("Commits")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: client.readGeneration(request)) { await load() }
    }

    private func load() async {
        do { list = try await client.forgeCommits(project: route.project, number: route.number, repository: route.repository); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}

/// The commit list both the Commits page and Files changed's range sheet use. A row picks that
/// commit alone; Compare two commits turns the rows into a two-step pick: first the commit to
/// start after, then a later one to end at. `all`, when given, offers All commits first.
struct ForgeCommitPicker: View {
    let commits: [ForgeCommits.Commit]
    var truncated = false
    var current: ForgeRange?
    var all: (() -> Void)?
    /// "Since your last review", offered beside All commits when there is something new.
    var sinceReview: ForgeCommits.SinceReview?
    let pick: (ForgeRange) -> Void
    @State private var comparing = false
    /// The commit a span starts after, once picked.
    @State private var after: String?
    @State private var picked = 0

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if commits.count > 1 { compareBar }
            if let all, !comparing {
                choiceRow(title: "All commits", line: commits.count == 1 ? "1 commit" : "\(commits.count) commits",
                          chosen: current == nil, identifier: "forge.commits.all", action: all)
                if let sinceReview {
                    let range = ForgeRange(commit: sinceReview.commit, since: sinceReview.since)
                    choiceRow(title: "Since your last review",
                              line: sinceReview.count == 1 ? "1 new commit" : "\(sinceReview.count) new commits",
                              chosen: current == range, identifier: "forge.commits.since-review") { pick(range) }
                        .transition(.opacity)
                }
            }
            ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                row(commit, index)
            }
            if truncated {
                Text("Only the newest commits are listed.").meta()
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
        .animation(.smooth, value: comparing)
        .animation(.smooth, value: after)
    }

    private var compareBar: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            // Only while comparing does the line say which commit to pick next.
            if comparing {
                Text(after == nil ? "Pick the commit to start after" : "Now pick the last commit")
                    .meta()
                    .contentTransition(.opacity)
                    .transition(.opacity)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Button(comparing ? "Stop comparing" : "Compare two commits") {
                comparing.toggle()
                after = nil
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .frame(minHeight: 44)
            .accessibilityIdentifier("forge.commits.compare")
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
    }

    private func row(_ commit: ForgeCommits.Commit, _ index: Int) -> some View {
        let start = after.flatMap { sha in commits.firstIndex { $0.sha == sha } }
        let state: String? = comparing && commit.sha == after ? "Start after this" : nil
        let chosen = !comparing && current?.since == nil && current?.commit == commit.sha
        return choiceRow(title: commit.title, line: line(commit), chosen: chosen, word: state,
                         stats: (commit.additions, commit.deletions), identifier: "forge.commit.\(index)") {
            choose(commit, index, start: start)
        }
        // A commit at or before the start can't end a span.
        .opacity(comparing && start.map { index <= $0 && commit.sha != after } == true ? 0.45 : 1)
    }

    private func choose(_ commit: ForgeCommits.Commit, _ index: Int, start: Int?) {
        picked += 1
        guard comparing else { return pick(ForgeRange(commit: commit.sha)) }
        guard let after, let start, index > start else { return self.after = commit.sha }
        comparing = false
        self.after = nil
        pick(ForgeRange(commit: commit.sha, since: after))
    }

    private func line(_ commit: ForgeCommits.Commit) -> String {
        var parts = [commit.short, commit.author]
        if let at = commit.at { parts.append(ActivityTime.age(since: Date(timeIntervalSince1970: at / 1000), now: .now)) }
        return parts.joined(separator: " · ")
    }

    private func choiceRow(title: String, line: String, chosen: Bool, word: String? = nil, stats: (Int?, Int?) = (nil, nil),
                           identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .fontWeight(chosen ? .semibold : .regular)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    HStack(spacing: AceTheme.Spacing.xs) {
                        Text(line).monospacedDigit().lineLimit(1)
                        if let word { Text(verbatim: "·"); Text(word).foregroundStyle(AceTheme.Colours.foreground) }
                    }
                    .meta()
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                if let add = stats.0, let del = stats.1 { ForgeDiffStat(additions: add, deletions: del) }
            }
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityAddTraits(chosen || word != nil ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}
