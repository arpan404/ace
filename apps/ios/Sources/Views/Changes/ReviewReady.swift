import SwiftUI

extension EnvironmentValues {
    /// Opens the thread's Changes, at a file when one is named. The thread screen sets it; nil
    /// leaves the review sheet's file rows as rows to mark viewed only.
    @Entry var openChanges: ((String?) -> Void)? = nil
    /// Brings the keyboard up in the thread's composer.
    @Entry var focusComposer: (() -> Void)? = nil
}

extension ClientModel {
    /// Send the thread's unsent line comments to the agent (`bridge/thread-review.ts`), waiting
    /// until the daemon took them. False with the refusal as the screen's error.
    func sendComments() async -> Bool {
        guard canOperate else { return false }
        let id = "comments-\(UUID().uuidString.prefix(18))"
        guard sheet(["kind": "review.comments.send", "requestId": id]) else { return false }
        // The daemon records and queues the comments in well under a second; a minute is the
        // most a slow link may take before the send is called failed.
        for _ in 0..<1200 {
            if let notice = sheets.notices[id] {
                if !notice.ok { error = notice.message }
                return notice.ok
            }
            do { try await Task.sleep(for: .milliseconds(50)) } catch { return false }
        }
        error = "The comments didn't send. Try again."
        return false
    }
    /// Take every unsent comment off the thread.
    func clearComments() { sheet(["kind": "review.comments.clear"]) }
}

/// Under the agent's last message once the whole tree is done and the checkout changed: one quiet
/// line ("9 files · +214 −61") with Review, which opens the review sheet. The bridge decides
/// when it shows; it goes the moment any agent works or waits again.
struct ReviewReadyLine: View {
    @Bindable var model: ClientModel
    @State private var reviewing = false

    var body: some View {
        Group {
            if let ready = model.sheets.ready {
                Button { reviewing = true } label: {
                    HStack(spacing: AceDesign.Space.related) {
                        ReviewCounts(ready: ready)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("Review").foregroundStyle(AceDesign.Ink.primary)
                    }
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .frame(minHeight: AceDesign.Size.tap)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, AceDesign.Space.margin)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ready to review: \(ready.line)")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("review.ready")
                .transition(.opacity)
            }
        }
        .animation(.default, value: model.sheets.ready)
        .sheet(isPresented: $reviewing) { ReviewReadySheet(model: model) }
    }
}

/// "9 files · +214 −61 · checks passed": counts in subtle ink, added and removed lines in their
/// diff colours, as every changes count in ace reads.
struct ReviewCounts: View {
    let ready: ReviewReadyRow
    var body: some View {
        let files = ready.files == 1 ? "1 file" : "\(ready.files.formatted()) files"
        (Text("\(files) · ").foregroundStyle(AceDesign.Ink.subtle)
         + Text("+\(ready.additions)").foregroundStyle(AceTheme.StatusText.done)
         + Text(" ")
         + Text("−\(ready.deletions)").foregroundStyle(AceTheme.StatusText.failed)
         + Text(ready.checks.map { " · \($0)" } ?? "").foregroundStyle(AceDesign.Ink.subtle))
            .monospacedDigit()
            .lineLimit(1)
    }
}

/// The finished turn's review, as a system sheet: what changed, the files to tick off as viewed,
/// then what to do with it. Ask for changes goes back to the composer, where the line comments
/// already wait as one chip; Open pull request, View pull request or Merge is the next git step
/// the bridge offers; Fork starts a new thread from here. It closes itself if an agent starts
/// working again.
struct ReviewReadySheet: View {
    @Bindable var model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openChanges) private var openChanges
    @Environment(\.focusComposer) private var focusComposer
    @Environment(\.openPullRequest) private var openPull
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var opened = false
    @State private var writingPR = false
    @State private var committing = false
    @State private var confirmingMerge = false
    @State private var request: String?
    @State private var allFiles = false
    /// Files shown before "N more files".
    private static let firstFiles = 5

    private var ready: ReviewReadyRow? { model.sheets.ready }
    private var summary: ChangesSummary? { model.sheets.changes }
    private var step: ChangesSummary.Step? { summary?.state == "ready" ? summary?.step : nil }
    private var outcome: GitOutcome? { request.flatMap { model.sheets.outcomes[$0] } }
    private var running: Bool { summary?.busy == true || (request != nil && outcome == nil) }
    private var method: MergeMethodOption? { summary?.methods?.first { $0.method == savedMethod } ?? summary?.methods?.first }

    var body: some View {
        NavigationStack {
            List {
                heading
                    .listRowInsets(EdgeInsets(top: AceDesign.Space.related, leading: AceDesign.Space.margin, bottom: AceDesign.Space.row, trailing: AceDesign.Space.margin))
                    .listRowSeparator(.hidden)
                files
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { actions }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("review.sheet.close")
                }
                if model.canOperate {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Fork") {
                            dismiss()
                            Task { _ = await model.openFork(.latest) }
                        }
                        .accessibilityHint("Starts a new thread from this point")
                        .accessibilityIdentifier("review.fork")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(AceDesign.Ink.primary)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $writingPR) {
            if let step { GitMessageSheet(model: model, kind: "create-pr", submitLabel: step.label, initialTitle: model.thread?.metadata?.title ?? "") { send($0) } }
        }
        .sheet(isPresented: $committing) {
            if let step { GitMessageSheet(model: model, kind: "commit", submitLabel: step.label, initialTitle: model.thread?.metadata?.title ?? "") { send($0) } }
        }
        .confirmationDialog("\(method?.label ?? "Merge") pull request #\(step?.pr?.number ?? 0)?", isPresented: $confirmingMerge, titleVisibility: .visible) {
            Button(method?.label ?? "Merge") { send(["kind": "merge", "method": method?.method ?? "squash"]) }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            // The page's Changes may already follow the thread; the sheet only opens its own.
            if model.sheets.changes == nil {
                opened = true
                model.sheet(["kind": "changes", "open": true])
                // The review covers everything the checkout holds, as the line's counts do.
                model.sheet(["kind": "changes.scope", "scope": "working-tree"])
            }
        }
        .onDisappear { if opened { model.sheet(["kind": "changes", "open": false]) } }
        // Never left up while the tree works or waits again: the bridge took the line away.
        .onChange(of: ready == nil) { _, gone in if gone { dismiss() } }
        .onChange(of: outcome) { _, outcome in
            if outcome?.ok == true { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text("Ready to review")
                .aceFont(AceDesign.TextRole.header, relativeTo: .title3)
                .foregroundStyle(AceDesign.Ink.primary)
                .accessibilityAddTraits(.isHeader)
            if let ready {
                ReviewCounts(ready: ready).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                if !ready.branch.isEmpty {
                    Text(ready.branch).aceMonospace(AceDesign.TextRole.branch, relativeTo: .caption)
                        .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var files: some View {
        if let summary, !summary.files.isEmpty {
            let shown = allFiles ? summary.files : Array(summary.files.prefix(Self.firstFiles))
            ForEach(shown) { file in
                ReviewFileRow(file: file, open: openChanges.map { open in { dismiss(); open(file.path) } })
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                    .listRowBackground(AceTheme.Colours.background)
                    .listRowSeparatorTint(AceTheme.Colours.separator)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) { viewedAction(file) }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) { viewedAction(file) }
            }
            let more = summary.files.count - shown.count + summary.hidden
            if more > 0 {
                Button(more == 1 ? "1 more file" : "\(more.formatted()) more files") {
                    if summary.hidden > 0, let openChanges { dismiss(); openChanges(nil) }
                    else { withAnimation { allFiles = true } }
                }
                .buttonStyle(.plain)
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(minHeight: AceDesign.Size.tap)
                .listRowSeparator(.hidden)
                .listRowBackground(AceTheme.Colours.background)
                .accessibilityIdentifier("review.moreFiles")
            }
        } else if summary == nil || summary?.state == "loading" {
            SkeletonRows(count: 3, label: "Reading changes")
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
        }
    }

    private func viewedAction(_ file: ChangesSummary.File) -> some View {
        let viewed = file.viewed == true
        return Button(viewed ? "Not viewed" : "Viewed") {
            model.sheet(["kind": "changes.viewed", "path": file.path, "viewed": !viewed])
            UISelectionFeedbackGenerator().selectionChanged()
        }
        .tint(AceDesign.Ink.muted)
    }

    /// Ask for changes beside the next git step, as capsules; the step's progress or outcome as
    /// one line above them.
    private var actions: some View {
        VStack(spacing: AceDesign.Space.related) {
            if let line = statusLine {
                Text(line.0).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(line.1).lineLimit(2).multilineTextAlignment(.center)
                    .accessibilityIdentifier("review.outcome")
            }
            if model.canOperate {
                HStack(spacing: AceDesign.Space.related) {
                    Button { askForChanges() } label: {
                        Text("Ask for changes").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("review.askForChanges")
                    if let next = nextAction {
                        Button { next.run() } label: {
                            Group { if running { ProgressView() } else { Text(next.label) } }.frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AceTheme.Colours.accent)
                        .foregroundStyle(AceDesign.Ink.onAccent)
                        .disabled(running || next.blocked)
                        .accessibilityIdentifier("review.next")
                    }
                }
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .aceFont(AceDesign.TextRole.action, relativeTo: .body)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.related)
        .background(AceTheme.Colours.background)
    }

    private struct Next { let label: String; let blocked: Bool; let run: () -> Void }

    /// The one git step that moves this work on, as the bridge orders them: commit, push, open a
    /// pull request, merge it; else the pull request there is.
    private var nextAction: Next? {
        if let step, step.kind != "none" {
            let blocked = step.blocked != nil
            switch step.kind {
            case "create-pr": return Next(label: "Open pull request", blocked: blocked) { writingPR = true }
            case "commit": return Next(label: step.label, blocked: blocked) { committing = true }
            case "merge": return Next(label: method?.label ?? step.label, blocked: blocked) { confirmingMerge = true }
            default: return Next(label: step.label, blocked: blocked) { send(["kind": step.kind]) }
            }
        }
        if let pr = ready?.pr {
            return Next(label: "View pull request", blocked: false) { viewPull(pr) }
        }
        return nil
    }

    private var statusLine: (String, Color)? {
        if let outcome { return (outcome.message, outcome.ok ? AceDesign.Ink.muted : AceTheme.StatusText.failed) }
        if let reason = step?.blocked { return (reason, AceDesign.Ink.muted) }
        if !model.canOperate { return ("View only: this phone can't open or merge pull requests.", AceDesign.Ink.muted) }
        return nil
    }

    private func askForChanges() {
        dismiss()
        focusComposer?()
    }
    private func viewPull(_ pr: ReviewReadyRow.PullRequest) {
        if let openPull, let ready, !ready.project.isEmpty {
            dismiss()
            openPull(ready.project, pr.number, pr.repo)
        } else if let url = URL(string: pr.url) {
            UIApplication.shared.open(url)
        }
    }
    private func send(_ action: [String: Any]) { request = model.gitStep(action) }
}

/// One changed file in the review: the path in mono (its folder quieter), and either its −/+
/// counts or "Viewed" once ticked off. Swipe either way to mark it.
struct ReviewFileRow: View {
    let file: ChangesSummary.File
    let open: (() -> Void)?
    var body: some View {
        let viewed = file.viewed == true
        let row = HStack(spacing: AceDesign.Space.related) {
            ChangedPath(path: file.path)
            Spacer(minLength: AceDesign.Space.related)
            FileStatusWord(status: file.status)
            if viewed {
                Text("Viewed").foregroundStyle(AceDesign.Ink.subtle)
            } else if file.binary {
                Text("binary").foregroundStyle(AceDesign.Ink.subtle)
            } else {
                DiffCounts(additions: file.additions, deletions: file.deletions)
            }
        }
        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .frame(minHeight: AceDesign.Size.rowLine)
        .opacity(viewed ? AceDesign.Ink.settledOpacity : 1)
        .contentShape(Rectangle())
        Group {
            if let open { Button(action: open) { row }.buttonStyle(.plain) } else { row }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(file.path), \(viewed ? "viewed" : "\(file.additions) added, \(file.deletions) removed")")
        .accessibilityIdentifier("review.file.\(file.path)")
    }
}

/// A changed file's path in mono: the folder in muted ink, the name in full ink, cut from the
/// front so the name always shows.
struct ChangedPath: View {
    let path: String
    var body: some View {
        let folder = (path as NSString).deletingLastPathComponent
        let name = (path as NSString).lastPathComponent
        (Text(folder.isEmpty ? "" : folder + "/").foregroundStyle(AceDesign.Ink.muted)
         + Text(name).foregroundStyle(AceDesign.Ink.primary))
            .aceMonospace(FileDiffStyle.path, relativeTo: .footnote)
            .lineLimit(1).truncationMode(.head)
    }
}

/// "+48 −12" in the diff's colours; a zero side is left out.
struct DiffCounts: View {
    let additions: Int
    let deletions: Int
    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            if additions > 0 || deletions == 0 { Text("+\(additions)").foregroundStyle(AceTheme.StatusText.done) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(AceTheme.StatusText.failed) }
        }
        .aceMonospace(FileDiffStyle.path, relativeTo: .footnote)
        .monospacedDigit()
        .fixedSize()
    }
}
