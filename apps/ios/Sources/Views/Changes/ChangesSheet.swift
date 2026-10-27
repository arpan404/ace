import SwiftUI

/// A thread's changes for review: a scope in the title (Uncommitted, Last turn, This thread, a
/// turn), each file under a sticky header (open several at once, tick one off once read), rows
/// paged in as you read, comments under the lines they're on, and the review at the foot. The
/// next git step stays in the ⋯ menu. The bridge keeps comments, viewed marks and the layout on
/// this phone between launches.
struct ChangesSheet: View {
    @Bindable var model: ClientModel
    let title: String
    /// A file whose diff opens first (from Files); otherwise the first file's.
    var initial: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var wrap = true
    @State private var selection: LineSelection?
    /// One layer at a time over the sheet: a comment being written, replies, the review, the tree.
    @State private var presented: Presented?
    @State private var opened = false
    @State private var target: String?
    private var summary: ChangesSummary? { model.sheets.changes }
    private var openPaths: Set<String> { Set(summary?.open ?? []) }
    /// Line comments go on Uncommitted only; the bridge says why not elsewhere.
    private var commentable: Bool { summary?.review?.allowed ?? true }
    /// Split needs room for two columns of code: iPad and wide windows.
    private var split: Bool { summary?.layout == "split" && sizeClass == .regular }

    enum Presented: Identifiable {
        case compose(Composing), replies(ChangesReview.Draft), review, tree
        var id: String {
            switch self {
            case .compose(let item): "compose:\(item.id)"
            case .replies(let draft): "replies:\(draft.key)"
            case .review: "review"
            case .tree: "tree"
            }
        }
    }

    struct Composing: Identifiable {
        let path: String; let side: String; let start: Int; let end: Int; let current: String
        var editing: ChangesReview.Draft?
        var id: String { "\(path)#\(side)#\(start)-\(end)#\(editing?.key ?? "")" }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none, pinnedViews: [.sectionHeaders]) {
                        content
                    }
                    .animation(reduceMotion ? nil : .smooth(duration: AceTheme.Motion.standard), value: summary?.open ?? [])
                    .environment(\.changesCommentable, commentable)
                }
                .onChange(of: target) { _, path in
                    guard let path else { return }
                    withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo(path, anchor: .top) }
                    target = nil
                }
            }
            .background(AceTheme.Colours.background)
            .refreshable {
                model.sheet(["kind": "changes.refresh"])
                model.sheet(["kind": "review.refresh"])
            }
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("changes.close")
                }
                ToolbarItem(placement: .principal) { header }
            }
            .changesActions(model: model, summary: summary, title: title, wrap: $wrap)
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                // Pinned, so Collapse all and Files stay in reach deep inside a long diff.
                if let summary, summary.state != "error" { toolbarRow(summary).background(AceTheme.Colours.background) }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                ReviewBar(model: model, selection: $selection, comment: compose, list: { presented = .review })
                    .environment(\.changesCommentable, commentable)
            }
            .sheet(item: $presented) { layer in
                switch layer {
                case .compose(let item):
                    ReviewComposer(model: model, path: item.path, side: item.side, start: item.start, end: item.end,
                                   current: item.current, editing: item.editing)
                        .onDisappear { selection = nil }
                case .replies(let draft):
                    ReviewRepliesSheet(model: model, draft: draft)
                case .review:
                    ReviewCommentsSheet(model: model, reveal: { reveal($0.path) })
                case .tree:
                    ChangesTreeSheet(model: model) { path in reveal(path) }
                        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .onAppear {
            model.sheet(["kind": "changes", "open": true])
            if let initial { model.sheet(["kind": "changes.scope", "scope": "working-tree"]); open(initial) }
        }
        .onDisappear { model.sheet(["kind": "changes", "open": false]) }
        // The first file opens by itself once, as before; after that opening is the person's.
        .onChange(of: summary?.files.first?.path) { _, first in
            guard !opened, initial == nil, let first, summary?.open?.isEmpty ?? true else { return }
            opened = true
            open(first)
        }
    }

    @ViewBuilder private var content: some View {
        if let summary {
            if summary.state == "error" {
                EmptyState(icon: nil, title: "Couldn't read changes", line: "Check that this thread has a git checkout, then refresh.", failed: true) {
                    Button("Refresh") { model.sheet(["kind": "changes.refresh"]) }
                }
                .centredInSheet()
            } else if summary.state == "loading" && summary.files.isEmpty {
                loading
            } else if summary.files.isEmpty {
                EmptyState(icon: .checkCircle, title: "No changes", line: emptyLine(summary)) { EmptyView() }
                    .centredInSheet()
            } else {
                ForEach(summary.files) { file in
                    let isOpen = openPaths.contains(file.path)
                    Section {
                        if isOpen {
                            ChangesFileBody(model: model, path: file.path, wrap: wrap, split: split, selection: $selection) { draft in
                                AnyView(ReviewCommentCard(model: model, draft: draft, edit: edit, replies: { presented = .replies($0) }))
                            }
                            .transition(.opacity)
                        }
                    } header: {
                        ChangedFileHeader(file: file, open: isOpen, reviewed: file.viewed == true,
                                          toggle: { toggle(file.path) },
                                          review: { view(file) })
                            .id(file.path)
                    }
                }
                footer(summary)
            }
        } else {
            loading
        }
    }

    /// Under the title: the file count, then Files (the tree) and Expand all or Collapse all.
    private func toolbarRow(_ summary: ChangesSummary) -> some View {
        HStack(spacing: AceTheme.Spacing.lg) {
            Text(summary.totals.files == 1 ? "1 file" : "\(summary.totals.files.formatted()) files")
                .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
            if let review = model.sheets.review, review.refreshing { ProgressView().controlSize(.mini) }
            Spacer(minLength: AceTheme.Spacing.sm)
            if summary.scope?.workingTree != false {
                Button("Review") { presented = .review }
                    .accessibilityIdentifier("changes.review")
            }
            if summary.files.count > 1 {
                Button("Files") { presented = .tree }
                    .accessibilityIdentifier("changes.tree")
            }
            if !summary.files.isEmpty {
                let anyOpen = !(summary.open ?? []).isEmpty
                Button(anyOpen ? "Collapse all" : "Expand all") {
                    model.sheet(["kind": "changes.expand", "open": !anyOpen])
                    UISelectionFeedbackGenerator().selectionChanged()
                }
                .accessibilityIdentifier("changes.expand")
            }
        }
        .buttonStyle(.plain)
        .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: 44)
    }

    private var loading: some View { ProgressView().controlSize(.large).centredInSheet().accessibilityLabel("Reading changes") }

    private func emptyLine(_ summary: ChangesSummary) -> String {
        if summary.scope?.workingTree == false { return "This turn didn't change any files." }
        return summary.branch.isEmpty ? "Everything is committed." : "Everything on \(summary.branch) is committed."
    }

    /// The scope menu in the title, over a quiet "+42 −8".
    private var header: some View {
        Menu {
            Picker("Show", selection: Binding(get: { summary?.scope?.id ?? "working-tree" }, set: { scope($0) })) {
                ForEach(summary?.scopes ?? []) { scope in Text(scope.label).tag(scope.id) }
            }
        } label: {
            VStack(spacing: AceTheme.Spacing.none) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text(summary?.scope?.label ?? "Changes")
                        .aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1)
                    if (summary?.scopes?.count ?? 0) > 1 {
                        Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                if let totals = summary?.totals, totals.files > 0 {
                    Text("+\(totals.additions) −\(totals.deletions)")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                        .accessibilityLabel("\(totals.additions) added, \(totals.deletions) removed")
                        .accessibilityIdentifier("changes.totals")
                }
            }
            .foregroundStyle(AceTheme.Colours.foreground)
        }
        .disabled((summary?.scopes?.count ?? 0) < 2)
        .accessibilityIdentifier("changes.scope")
    }

    @ViewBuilder private func footer(_ summary: ChangesSummary) -> some View {
        if summary.hidden > 0 || summary.partial {
            Text(summary.partial ? "More files changed than one read returns." : "\(summary.hidden) more \(summary.hidden == 1 ? "file" : "files") changed")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(AceTheme.Spacing.lg)
        }
        Color.clear.frame(height: 72)
    }

    // MARK: Actions

    private func scope(_ id: String) {
        selection = nil
        // A pick can't carry over: comments don't go on every scope.
        model.sheet(["kind": "changes.scope", "scope": id])
        UISelectionFeedbackGenerator().selectionChanged()
    }
    private func toggle(_ path: String) {
        if openPaths.contains(path) { model.sheet(["kind": "changes.open", "path": path, "open": false]) }
        else { open(path) }
    }
    private func open(_ path: String) {
        if (summary?.open?.count ?? 0) >= (summary?.openLimit ?? 30) {
            // At the limit the oldest open file closes, so a tap always opens what was tapped.
            if let oldest = summary?.open?.first { model.sheet(["kind": "changes.open", "path": oldest, "open": false]) }
        }
        model.sheet(["kind": "changes.open", "path": path, "open": true])
    }
    private func view(_ file: ChangesSummary.File) {
        model.sheet(["kind": "changes.viewed", "path": file.path, "viewed": !(file.viewed ?? false)])
    }
    private func reveal(_ path: String) {
        if !openPaths.contains(path) { open(path) }
        target = path
    }
    private func compose() {
        guard let selection else { return }
        let rows = model.sheets.files[selection.path].map { model.sheets.rows($0) } ?? []
        let current = rows.filter { selection.contains($0, in: selection.path) }.map(\.text).joined(separator: "\n")
        presented = .compose(Composing(path: selection.path, side: selection.side, start: selection.start, end: selection.end, current: current))
    }
    private func edit(_ draft: ChangesReview.Draft) {
        presented = .compose(Composing(path: draft.path, side: draft.side, start: draft.start, end: draft.end, current: draft.suggestion ?? "", editing: draft))
    }
}

extension View {
    /// An empty, error or loading state in the middle of the sheet rather than pinned to its top.
    func centredInSheet() -> some View {
        frame(maxWidth: .infinity).containerRelativeFrame(.vertical, alignment: .center) { height, _ in height * 0.7 }
    }
}

/// A file's sticky 52pt header: disclosure, status mark, the path in mono with its name in bold,
/// −N +N, and a box to tick once it's been read (the tick clears when the file's diff changes).
struct ChangedFileHeader: View {
    let file: ChangesSummary.File
    let open: Bool
    let reviewed: Bool
    let toggle: () -> Void
    let review: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
            Button(action: toggle) {
                HStack(spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(reduceMotion ? nil : .smooth(duration: AceTheme.Motion.standard), value: open)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                    FileStatusMark(status: file.status)
                    path
                    Spacer(minLength: AceTheme.Spacing.xs)
                    counts
                }
                .frame(minHeight: 52).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityValue(open ? "Open" : "Closed")
            .accessibilityIdentifier("changes.file.\(file.path)")
            Button(action: review) {
                Image(systemName: reviewed ? "checkmark.square.fill" : "square").font(.title3)
                    .foregroundStyle(reviewed ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: reviewed)
            .accessibilityLabel("Viewed").accessibilityAddTraits(reviewed ? .isSelected : [])
            .accessibilityIdentifier("changes.reviewed.\(file.path)")
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
        .opacity(reviewed && !open ? 0.6 : 1)
    }
    private var path: some View {
        let folder = (file.path as NSString).deletingLastPathComponent
        let name = (file.path as NSString).lastPathComponent
        return VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            (Text(folder.isEmpty ? "" : folder + "/").foregroundStyle(AceTheme.Colours.mutedForeground)
             + Text(name).foregroundStyle(AceTheme.Colours.foreground).fontWeight(.medium))
                .aceMonospace(FileDiffStyle.path, relativeTo: .footnote).lineLimit(1).truncationMode(.head)
            if let from = file.from {
                Text("from \(from)").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
            }
        }
    }
    private var counts: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if file.binary { Text("binary").foregroundStyle(AceTheme.Colours.mutedForeground) }
            else if file.counted == false { Text("—").foregroundStyle(AceTheme.Colours.mutedForeground) }
            else {
                Text("−\(file.deletions)").foregroundStyle(AceTheme.StatusText.failed)
                Text("+\(file.additions)").foregroundStyle(AceTheme.StatusText.done)
            }
        }
        .aceMonospace(FileDiffStyle.path, relativeTo: .footnote).fixedSize()
    }
}

/// A file's git status as a small outlined square: a dot for modified, + added, − deleted,
/// → renamed.
struct FileStatusMark: View {
    let status: String
    var body: some View {
        AceShape.glyph.stroke(colour, lineWidth: 1.5)
            .frame(width: 20, height: 20)
            .overlay {
                if status == "modified" { Circle().fill(colour).frame(width: 6, height: 6) }
                else { Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(colour) }
            }
            .accessibilityLabel(status.capitalized)
    }
    private var colour: Color {
        switch status {
        case "deleted": AceTheme.StatusText.failed
        case "renamed", "moved": AceTheme.StatusText.working
        default: AceTheme.StatusText.done
        }
    }
    private var symbol: String {
        switch status {
        case "deleted": "minus"
        case "renamed", "moved": "arrow.right"
        default: "plus"
        }
    }
}
