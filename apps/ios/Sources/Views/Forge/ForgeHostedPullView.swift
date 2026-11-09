import SwiftUI

/// A review on a host ace only reads (GitLab, Cursor Origin), as the web's read-only page shows
/// it: state, title and branches, one line saying the rest happens on the host, the description
/// and the changed files a page at a time. It offers no merge, review, comment or check controls;
/// "Open on <Provider>" sits in the page's menu.
struct ForgeHostedPullView: View {
    let client: ClientModel
    let route: ForgeRoute
    let page: ForgePullPage
    let hosted: ForgeHostedReview
    let open: (ForgeRoute) -> Void
    /// Reads the page again, when its branch moved under the files.
    let reload: () async -> Void
    @State private var files: ForgeHostedFiles?
    @State private var filesPage = 1
    @State private var failure: String?
    /// The branch moved under the files shown; said until the person turns the page.
    @State private var moved = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            header
            Text(hosted.line).meta().padding(.horizontal, AceTheme.Spacing.lg)
                .accessibilityIdentifier("forge.hosted.line")
            Group {
                if page.body.isEmpty { Text("No description.").meta() }
                else {
                    ForgeText(text: page.body, scope: ForgeRichScope(client: client, project: route.project, repository: page.repository),
                              hosted: hosted.links)
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            filesSection
        }
        .padding(.vertical, AceTheme.Spacing.md)
        // On Cursor Origin `#N` is another review of this repository: it opens here, as its page.
        .environment(\.openURL, OpenURLAction { url in
            if let number = ForgeLinks.reviewNumber(url) {
                open(ForgeRoute(kind: .pull, machineId: route.machineId, project: route.project, number: number, repository: page.repository))
            } else {
                openURL(url)
            }
            return .handled
        })
        .task(id: FilesKey(page: filesPage, head: page.headSha, generation: client.readGeneration(filesRequest))) { await loadFiles() }
    }

    private struct FilesKey: Hashable { let page: Int; let head: String; let generation: Int }

    /// What a refresh puts out of date; the head shown is left out, so learning it reads nothing again.
    private var filesRequest: [String: Any] {
        ClientModel.forgeHostedFilesRead(project: route.project, number: route.number, repository: page.repository, page: filesPage, headSha: nil)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgePullGlyph(state: page.state, merged: page.merged, size: AceDesign.Size.icon)
                Text(page.state.word).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTone(page.state.tone).text)
                Text("\(page.repository.owner)/\(page.repository.name)").meta().lineLimit(1).truncationMode(.middle)
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
            Text("\(page.author) \(page.merged ? "merged into" : "wants to merge into") \(page.baseBranch) from \(page.headBranch)")
                .meta().lineLimit(2).truncationMode(.middle)
            if let additions = page.additions, let deletions = page.deletions {
                ForgeDiffStat(additions: additions, deletions: deletions)
            }
            ForgeLabels(labels: page.labels, limit: 8)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .accessibilityIdentifier("forge.pull.header")
    }

    /// "Files changed", with the host's count only when it gave one.
    private var filesTitle: String {
        guard let count = page.changedFiles, count > 0 else { return "Files changed" }
        return count == 1 ? "1 file changed" : "\(count) files changed"
    }

    @ViewBuilder private var filesSection: some View {
        if let unavailable = hosted.filesUnavailable {
            Text(unavailable).meta().padding(.horizontal, AceTheme.Spacing.lg)
        } else {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                ForgeSection(title: filesTitle) {
                    if let files {
                        ForEach(Array(files.files.enumerated()), id: \.element) { index, file in fileRow(file, index, files.page) }
                    }
                }
                Group {
                    if let failure {
                        HStack(spacing: AceTheme.Spacing.sm) {
                            Text(failure).meta(AceTone.failed.text)
                            Button("Try again") { Task { await loadFiles() } }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        }
                    } else if let files {
                        if moved { Text("The branch moved since you looked: these are its new changes.").meta() }
                        if files.files.isEmpty { Text("No changed files on this page.").meta() }
                        if let truncated = files.truncated { Text(truncated).meta() }
                        if files.page > 1 || files.nextPage != nil { pager(files) }
                    } else {
                        Text("Loading changed files…").meta()
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
            }
            .accessibilityIdentifier("forge.hosted.files")
        }
    }

    private func pager(_ files: ForgeHostedFiles) -> some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Button("Previous page") { moved = false; filesPage = max(1, files.page - 1) }.disabled(files.page <= 1)
            Text("Page \(files.page)").monospacedDigit().meta()
            Button("Next page") { moved = false; if let next = files.nextPage { filesPage = next } }.disabled(files.nextPage == nil)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .frame(minHeight: AceDesign.Size.tap)
    }

    private func fileRow(_ file: ForgeHostedFiles.File, _ index: Int, _ onPage: Int) -> some View {
        Button {
            open(ForgeRoute(kind: .file, machineId: route.machineId, project: route.project, number: route.number, path: file.path,
                            index: (onPage - 1) * 25 + index, repository: page.repository))
        } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(file.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.head)
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeDiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceDesign.Size.tap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("forge.hosted.file.\(index)")
    }

    private func loadFiles() async {
        do {
            let read = try await client.forgeHostedFiles(project: route.project, number: route.number, repository: page.repository,
                                                         page: filesPage, headSha: files?.headSha)
            let headMoved = read.moved && files != nil
            files = read
            filesPage = read.page
            failure = nil
            // The header and counts were read at the old head: read them again too.
            if headMoved {
                moved = true
                await reload()
            }
        }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}
