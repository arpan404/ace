import SwiftUI

/// One changed file of a pull request (the web's Code tab, for the phone): its diff in SF Mono,
/// each line's conversations and pending review comments under it. Pressing a line opens a line
/// comment: Add single comment, or Start a review (Add review comment once one is pending), with
/// Suggest changes on lines of the new side. Conversations no shown line holds follow the diff.
struct ForgeFileView: View {
    let client: ClientModel
    let route: ForgeRoute
    @State private var file: ForgeFileDiff?
    @State private var failure: String?
    @State private var desk: ForgeReviewDesk?
    @State private var composing: ForgeCompose?
    private var path: String { route.path ?? "" }
    private var request: [String: Any] { ClientModel.forgeFileRead(project: route.project, number: route.number, path: path, index: route.index) }

    init(client: ClientModel, route: ForgeRoute) {
        self.client = client
        self.route = route
        let kept = client.kept(ClientModel.forgeFileRead(project: route.project, number: route.number, path: route.path ?? "", index: route.index), as: ForgeFileDiff.self)
        _file = State(initialValue: kept)
        _desk = State(initialValue: kept.map { ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: $0.number, repository: $0.repository)) })
    }

    var body: some View {
        ScrollView {
            if let file, let desk { content(file, desk) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't load this file", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            if let message = desk?.message, composing == nil {
                Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                    .background(AceTheme.Colours.background)
            }
        }
        .navigationTitle(Text(verbatim: (path as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: client.readGeneration(request)) { await load() }
        .sheet(item: $composing) { compose in
            if let desk { ForgeWriteSheet(compose: compose, desk: desk) }
        }
    }

    @ViewBuilder private func content(_ file: ForgeFileDiff, _ desk: ForgeReviewDesk) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(file.previousPath.map { "\($0) → \(file.path)" } ?? file.path)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2).truncationMode(.middle)
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeDiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            Divider().overlay(AceTheme.Colours.separator)
            if file.empty {
                Text("GitHub shows no lines for this file.").meta()
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            }
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
                    lineRow(line, file, desk)
                    ForEach(line.drafts) { draft in pendingRow(draft) }
                    ForEach(line.threads) { thread in
                        ForgeThreadBlock(thread: thread, showsPlace: false, desk: desk, compose: { composing = $0 })
                            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                            .background(AceTheme.Colours.background)
                    }
                }
            }
            if file.truncated {
                Text(file.hiddenLines > 0 ? "\(file.hiddenLines) more lines on GitHub" : "The rest of this file is on GitHub").meta()
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            }
            if !file.outside.isEmpty {
                ForgeSection(title: "Conversations outside the diff") {
                    ForEach(file.outside) { thread in
                        ForgeThreadBlock(thread: thread, desk: desk, compose: { composing = $0 })
                            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                    }
                }
                .padding(.top, AceTheme.Spacing.lg)
            }
        }
    }

    @ViewBuilder private func lineRow(_ line: ForgeFileDiff.Line, _ file: ForgeFileDiff, _ desk: ForgeReviewDesk) -> some View {
        let row = HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Text(verbatim: line.kind == "hunk" ? "" : String(line.new ?? line.old ?? 0))
                .monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(minWidth: 32, alignment: .trailing)
            Text(verbatim: marker(line) + line.text)
                .foregroundStyle(line.kind == "hunk" ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(.horizontal, AceTheme.Spacing.sm)
        .padding(.vertical, AceTheme.Spacing.xxs)
        .background(background(line))
        if let anchor = line.anchor, let commenting = file.commenting, client.canOperate {
            Button { comment(on: line, anchor: anchor, file: file, off: commenting.off, desk: desk) } label: { row.contentShape(Rectangle()) }
                .buttonStyle(.row)
                .accessibilityHint("Comment on this line")
                .accessibilityIdentifier("forge.line.\(anchor.side).\(anchor.line)")
        } else {
            row
        }
    }

    private func pendingRow(_ draft: ForgeFileDiff.Draft) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text("Pending").meta(AceTone.needsYou.text)
            MarkdownView(text: draft.body)
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
    }

    private func marker(_ line: ForgeFileDiff.Line) -> String {
        switch line.kind { case "add": "+"; case "del": "-"; case "hunk": ""; default: " " }
    }

    private func background(_ line: ForgeFileDiff.Line) -> Color {
        switch line.kind {
        case "add": AceTheme.Colours.diffAdd
        case "del": AceTheme.Colours.diffDelete
        case "hunk": AceTheme.Colours.fill
        default: .clear
        }
    }

    private func load() async {
        do {
            let read = try await client.forgeFile(project: route.project, number: route.number, path: path, index: route.index)
            if desk == nil { desk = ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: read.number, repository: read.repository)) }
            file = read
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    /// A new comment on one line: alone at once, or into the pending review.
    private func comment(on line: ForgeFileDiff.Line, anchor: ForgeFileDiff.Anchor, file: ForgeFileDiff, off: String?, desk: ForgeReviewDesk) {
        let place: [String: Any] = ["commit": file.headSha, "path": file.path, "line": anchor.line, "side": anchor.side]
        let head = file.headSha
        composing = ForgeCompose(
            title: anchor.side == "LEFT" ? "Comment on old line \(anchor.line)" : "Comment on line \(anchor.line)",
            text: "",
            primary: .init(label: file.pending > 0 ? "Add review comment" : "Start a review") { body in
                await desk.run(["kind": "draft.save", "draft": ["body": body, "anchor": place]])
            },
            secondary: .init(label: "Add single comment") { body in
                await desk.run(["kind": "line.comment", "headSha": head, "anchor": place, "body": body])
            },
            // A suggestion replaces lines of the new side; a deleted line has none to change.
            suggestion: line.kind == "del" ? nil : line.text,
            off: off)
    }
}
