import SwiftUI

/// One pull request as a page (the web's PR page, cardless): state, title and branches; the
/// merge gates; threads working on it; its description; reviewers, checks and files. The one
/// primary control sits at the bottom: merge, or turn auto-merge on, by the method last picked;
/// anything that can't merge says why in words. A merge is confirmed first and is never retried
/// on its own: the page reads GitHub again to show what happened.
struct ForgePullPageView: View {
    let client: ClientModel
    let route: ForgeRoute
    let openThread: (InboxKey) -> Void
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var page: ForgePullPage?
    @State private var failure: String?
    @State private var writing = false
    @State private var outcome: ForgeWrite?
    @State private var confirming: ForgePullPage.Action?
    @Environment(\.openURL) private var openURL

    private var method: String { savedMethod.isEmpty ? "squash" : savedMethod }

    var body: some View {
        ScrollView {
            if let page { content(page) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't load this pull request", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { if let page { bar(page) } }
        .navigationTitle(Text(verbatim: "#\(route.number)"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let page, let link = URL(string: page.url) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Open on GitHub", ace: .arrowSquareOut) { openURL(link) }
                        ShareLink(item: link) { Label("Share", ace: .export) }
                        Button("Copy link", ace: .copy) { UIPasteboard.general.url = link }
                    } label: { Image(ace: .dotsThree) }
                        .accessibilityLabel("More").accessibilityIdentifier("forge.pull.more")
                }
            }
        }
        .readWhenConnected(client, id: method) { await load() }
        .confirmationDialog(confirming?.label ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { action in
            Button(action.label) { Task { await write(action) } }
        } message: { _ in
            if let page { Text(verbatim: "#\(page.number) \(page.title)") }
        }
    }

    @ViewBuilder private func content(_ page: ForgePullPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            header(page)
            if !page.gates.isEmpty { ForgeSection(title: nil) { ForEach(page.gates, id: \.self) { gate in gateRow(gate) } } }
            if !page.blockers.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    ForEach(page.blockers, id: \.self) { Text($0).meta(AceTone.failed.text) }
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
            }
            ForgeThreadsSection(threads: page.threads, machineId: route.machineId, openThread: openThread)
            if !page.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownView(text: page.body).padding(.horizontal, AceTheme.Spacing.lg)
            }
            if !page.reviewers.isEmpty {
                ForgeSection(title: "Reviewers") {
                    ForEach(page.reviewers, id: \.self) { reviewer in
                        ForgeLine(leading: reviewer.login, trailing: reviewer.outcome ?? "Requested")
                    }
                }
            }
            if !page.checks.isEmpty {
                ForgeSection(title: "Checks") {
                    ForEach(page.checks, id: \.self) { check in
                        ForgeLine(leading: check.name, trailing: check.word, tone: check.tone)
                    }
                }
            }
            if !page.files.isEmpty {
                ForgeSection(title: page.changedFiles == 1 ? "1 file changed" : "\(page.changedFiles) files changed") {
                    ForEach(page.files, id: \.self) { file in
                        HStack(spacing: AceTheme.Spacing.sm) {
                            Text(file.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: AceTheme.Spacing.sm)
                            ForgeDiffStat(additions: file.additions, deletions: file.deletions)
                        }
                        .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 36)
                    }
                }
            }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    private func header(_ page: ForgePullPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgePullGlyph(state: page.state, merged: page.merged, size: 16)
                Text(page.state.word).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTone(page.state.tone).text)
                Text("\(page.repository.owner)/\(page.repository.name)").meta()
                Spacer(minLength: AceTheme.Spacing.none)
                if let updated = page.updatedAt {
                    TimelineView(.everyMinute) { context in
                        Text(ActivityTime.age(since: Date(timeIntervalSince1970: updated / 1000), now: context.date)).monospacedDigit().meta()
                    }
                }
            }
            Text(page.title).aceFont(AceTheme.Typography.title, relativeTo: .title3)
                .foregroundStyle(AceTheme.Colours.foreground)
                .textSelection(.enabled)
            Text("\(page.author) · \(page.commits == 1 ? "1 commit" : "\(page.commits) commits")").meta()
            Text("\(page.headBranch) → \(page.baseBranch)").aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
            if let additions = page.additions, let deletions = page.deletions {
                ForgeDiffStat(additions: additions, deletions: deletions)
            }
            ForgeLabels(labels: page.labels, limit: 8)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .accessibilityIdentifier("forge.pull.header")
    }

    private func gateRow(_ gate: ForgePullPage.Gate) -> some View {
        ForgeLine(leading: gate.label, trailing: gate.detail.map { "\(gate.value) · \($0)" } ?? gate.value, tone: gate.tone)
    }

    /// The bottom strip: the outcome of the last write, then the one control, or its words.
    @ViewBuilder private func bar(_ page: ForgePullPage) -> some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            if let outcome {
                Text(outcome.message).meta(outcome.ok ? AceTheme.Colours.mutedForeground : AceTone.failed.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.outcome")
            }
            if let action = page.action {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Button { confirming = action } label: {
                        HStack {
                            if writing { ProgressView().controlSize(.small) }
                            Text(action.label).fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(AceTheme.Colours.foreground)
                    .foregroundStyle(AceTheme.Colours.background)
                    .disabled(writing || action.disabled != nil || !client.canOperate)
                    .accessibilityIdentifier("forge.pull.primary")
                    if page.methods.count > 1 {
                        Menu {
                            Picker("Merge method", selection: Binding(get: { method }, set: { savedMethod = $0 })) {
                                ForEach(page.methods, id: \.self) { Text($0.label).tag($0.method) }
                            }
                        } label: {
                            Image(ace: .caretDown).frame(width: 44, height: 44)
                                .aceGlass(in: AceShape.capsule, interactive: true)
                                .contentShape(AceShape.capsule)
                        }
                            .accessibilityLabel("Merge method").accessibilityIdentifier("forge.pull.method")
                    }
                }
                if let reason = action.disabled { Text(reason).meta().frame(maxWidth: .infinity, alignment: .leading) }
            } else if !page.primary.isEmpty {
                Text(page.primary).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.primary")
            }
            if let secondary = page.secondary {
                Button(secondary.label) { Task { await write(secondary) } }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(AceTheme.Colours.foreground)
                    .disabled(writing || secondary.disabled != nil || !client.canOperate)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.secondary")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.background)
    }

    private func load() async {
        do { page = try await client.forgePull(project: route.project, number: route.number, method: method); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }

    private func write(_ action: ForgePullPage.Action) async {
        guard let page, !writing else { return }
        writing = true
        outcome = await client.forgeWrite(project: route.project, page: page, kind: action.kind, method: method)
        // What GitHub did is read, never assumed.
        await load()
        writing = false
    }
}
