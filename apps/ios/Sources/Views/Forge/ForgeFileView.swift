import SwiftUI

/// One changed file of a pull request (the web's Code tab, for the phone): its diff in SF Mono,
/// each line's conversations and pending review comments under it. Tapping a line picks it;
/// Select more then a later line of the same change picks a span; Comment opens the comment:
/// Add single comment, or Start a review (Add review comment once one is pending), with
/// Suggest changes on lines of the new side. The row under its name sets Wrap, Side by side
/// (where it fits), Rendered for Markdown, and marks the file Viewed. An image shows both
/// versions. Conversations no shown line holds follow the diff. A range of commits shows its
/// own diff alone: conversations and new comments belong to All commits.
struct ForgeFileView: View {
    let client: ClientModel
    let route: ForgeRoute
    @State private var file: ForgeFileDiff?
    @State private var failure: String?
    @State private var desk: ForgeReviewDesk?
    @State private var composing: ForgeCompose?
    @State private var pick: ForgeLinePick?
    @State private var pickNote: String?
    @State private var refused = 0
    @State private var marked = 0
    @State private var renderedOn = true
    @AppStorage("forge.code.wrap") private var wrap = true
    @AppStorage("forge.code.split") private var split = false
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.verticalSizeClass) private var height
    private var path: String { route.path ?? "" }
    private var wide: Bool { width == .regular || height == .compact }
    private var request: [String: Any] {
        ClientModel.forgeFileRead(project: route.project, number: route.number, repository: route.repository, path: path, index: route.index, range: route.range)
    }

    init(client: ClientModel, route: ForgeRoute) {
        self.client = client
        self.route = route
        let kept = client.kept(ClientModel.forgeFileRead(project: route.project, number: route.number, repository: route.repository,
                                                         path: route.path ?? "", index: route.index, range: route.range), as: ForgeFileDiff.self)
        _file = State(initialValue: kept)
        _desk = State(initialValue: kept.map { ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: $0.number, repository: $0.repository)) })
    }

    var body: some View {
        ScrollView {
            if let file, let desk { content(file, desk).transition(.opacity) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't load this file", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .animation(.smooth, value: file == nil)
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { bottom }
        .navigationTitle(Text(verbatim: (path as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: client.readGeneration(request)) { await load() }
        .sheet(item: $composing) { compose in
            if let desk { ForgeWriteSheet(compose: compose, desk: desk) }
        }
        .sensoryFeedback(.selection, trigger: pick)
        .sensoryFeedback(.error, trigger: refused)
        .sensoryFeedback(.success, trigger: marked)
    }

    @ViewBuilder private var bottom: some View {
        if let pick, composing == nil {
            ForgeLinePickStrip(pick: pick, note: pickNote, extend: {
                withAnimation(.smooth) { self.pick?.extending.toggle(); pickNote = nil }
            }, comment: { if let file, let desk { comment(file, desk) } }, clear: {
                withAnimation(.smooth) { self.pick = nil; pickNote = nil }
            })
            .transition(.opacity)
        } else if let message = desk?.message, composing == nil {
            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
        }
    }

    @ViewBuilder private func content(_ file: ForgeFileDiff, _ desk: ForgeReviewDesk) -> some View {
        let showsRendered = file.rendered && renderedOn
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(file.previousPath.map { "\($0) → \(file.path)" } ?? file.path)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2).truncationMode(.middle)
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeDiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.top, AceTheme.Spacing.sm)
            ForgeCodeToolbar(wrap: $wrap, split: $split,
                             rendered: file.rendered ? $renderedOn.animation(.smooth) : nil,
                             wide: wide && file.show == "patch", viewed: file.viewed,
                             canMark: client.canOperate, marking: !desk.ready) { markViewed(file, desk) }
            Divider().overlay(AceTheme.Colours.separator)
            if showsRendered {
                ForgeRenderedDiffView(client: client, route: route, scope: desk.scope)
            } else if file.show == "image" {
                ForgeImageDiffView(client: client, route: route)
            } else {
                if file.empty {
                    Text(file.show == "patch" ? "GitHub shows no lines for this file." : "GitHub sent no patch for this file; open it on GitHub.").meta()
                        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                }
                ForgeDiffLines(file: file, desk: desk, wrap: wrap, split: split && wide, pick: pick,
                               pickable: file.commenting != nil && client.canOperate,
                               tap: { tap($0, in: file) }, compose: { composing = $0 })
                if file.truncated {
                    Text(file.hiddenLines > 0 ? "\(file.hiddenLines) more lines on GitHub" : "The rest of this file is on GitHub").meta()
                        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                }
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
        .animation(.smooth, value: wrap)
        .animation(.smooth, value: split)
    }

    /// A tap on a line: it extends the span while Select more is on, else picks that line.
    private func tap(_ index: Int, in file: ForgeFileDiff) {
        let line = file.lines[index]
        guard let anchor = line.anchor else { return }
        withAnimation(.smooth) {
            if var current = pick, current.extending {
                if current.extend(to: anchor, hunk: line.hunk) {
                    pick = current
                    pickNote = nil
                } else {
                    pickNote = "Pick a line on the same side of this change"
                    refused += 1
                }
            } else if pick?.holds(line) == true, pick?.start == pick?.end {
                pick = nil
            } else {
                pick = ForgeLinePick(hunk: line.hunk, anchor: anchor)
                pickNote = nil
            }
        }
    }

    private func markViewed(_ file: ForgeFileDiff, _ desk: ForgeReviewDesk) {
        let action: [String: Any] = ["kind": file.viewed == "viewed" ? "file.unview" : "file.view", "path": file.path, "headSha": file.headSha]
        Task { if await desk.run(action) { marked += 1 } }
    }

    private func load() async {
        do {
            let read = try await client.forgeFile(project: route.project, number: route.number, repository: route.repository,
                                                  path: path, index: route.index, range: route.range)
            if desk == nil { desk = ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: read.number, repository: read.repository)) }
            // A pick names lines of the version it was made on; another head names other code.
            if read.headSha != file?.headSha { pick = nil }
            file = read
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    /// A new comment on the picked lines: alone at once, or into the pending review.
    private func comment(_ file: ForgeFileDiff, _ desk: ForgeReviewDesk) {
        guard let pick, let off = file.commenting.map({ $0.off }) else { return }
        let place = pick.anchor(path: file.path, commit: file.headSha)
        let head = file.headSha
        let picked = file.lines.filter { pick.holds($0) }
        // A suggestion replaces lines of the new side; deleted lines have none to change.
        let suggestion = pick.side == "RIGHT" ? picked.map(\.text).joined(separator: "\n") : nil
        let done: (Bool) -> Bool = { ok in
            if ok { withAnimation(.smooth) { self.pick = nil } }
            return ok
        }
        composing = ForgeCompose(
            title: "Comment on \(pick.label.prefix(1).lowercased() + pick.label.dropFirst())",
            text: "",
            primary: .init(label: file.pending > 0 ? "Add review comment" : "Start a review") { body in
                done(await desk.run(["kind": "draft.save", "draft": ["body": body, "anchor": place]]))
            },
            secondary: .init(label: "Add single comment") { body in
                done(await desk.run(["kind": "line.comment", "headSha": head, "anchor": place, "body": body]))
            },
            suggestion: suggestion,
            off: off)
    }
}
