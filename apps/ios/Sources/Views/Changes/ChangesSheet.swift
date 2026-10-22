import SwiftUI

/// The thread's uncommitted changes for review: each file under a sticky header (open it for its
/// diff, tick it off once read), and the next git step in the ⋯ menu. Steps go through the
/// daemon's guarded git; a view-only phone sees the diff but not the steps. The bridge sends one
/// file's diff at a time, so opening a file closes the one before.
struct ChangesSheet: View {
    @Bindable var model: ClientModel
    let title: String
    /// A file whose diff opens first (from Files); otherwise the first file's.
    var initial: String?
    @Environment(\.dismiss) private var dismiss
    @State private var open: String?
    @State private var reviewed: Set<String> = []
    @State private var wrap = true
    private var summary: ChangesSummary? { model.sheets.changes }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none, pinnedViews: [.sectionHeaders]) {
                        content
                    }
                }
                .task(id: summary?.files.contains { $0.path == initial } == true) {
                    if let initial, summary?.files.contains(where: { $0.path == initial }) == true { proxy.scrollTo(initial, anchor: .top) }
                }
            }
            .background(AceTheme.Colours.background)
            .refreshable { model.sheet(["kind": "changes.refresh"]) }
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { AceIcon(.x, size: 18) }
                        .accessibilityLabel("Close").accessibilityIdentifier("changes.close")
                }
            }
            .changesActions(model: model, summary: summary, title: title, wrap: $wrap)
        }
        .tint(AceTheme.Colours.foreground)
        .onAppear {
            model.sheet(["kind": "changes", "open": true])
            if let initial { show(initial) }
        }
        .onDisappear { model.sheet(["kind": "changes", "open": false]) }
        .onChange(of: summary?.files.first?.path) { _, first in if open == nil, let first { show(first) } }
    }

    @ViewBuilder private var content: some View {
        if let summary {
            if summary.state == "error" {
                EmptyState(icon: nil, title: "Couldn't read changes", line: "Check that this thread has a git checkout, then refresh.", failed: true)
                    .padding(.top, AceTheme.Spacing.xxxl * 2)
            } else if summary.state == "loading" && summary.files.isEmpty {
                ProgressView("Reading changes…").frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
            } else if summary.files.isEmpty {
                EmptyState(icon: .gitBranch, title: "No uncommitted changes").padding(.top, AceTheme.Spacing.xxxl * 2)
            } else {
                totals
                ForEach(summary.files) { file in
                    Section {
                        if open == file.path { FileDiffRows(model: model, path: file.path, wrap: wrap) }
                    } header: {
                        ChangedFileHeader(file: file, open: open == file.path, reviewed: reviewed.contains(file.path),
                                          toggle: { open == file.path ? show(nil) : show(file.path) },
                                          review: { if reviewed.contains(file.path) { reviewed.remove(file.path) } else { reviewed.insert(file.path) } })
                            .id(file.path)
                    }
                }
                footer(summary)
            }
        } else {
            ProgressView("Reading changes…").frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
        }
    }
    private func show(_ path: String?) {
        open = path
        if let path { model.sheet(["kind": "changes.file", "path": path]) }
        else { model.sheet(["kind": "changes.file", "path": NSNull()]) }
    }

    /// "3 files  +42 −8" over the files, as the web's changes toolbar counts them.
    @ViewBuilder private var totals: some View {
        if let totals = summary?.totals, totals.files > 0 {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text("\(totals.files) \(totals.files == 1 ? "file" : "files")").foregroundStyle(AceTheme.Colours.mutedForeground)
                (Text("+\(totals.additions)").foregroundStyle(AceTheme.StatusText.done)
                 + Text(" −\(totals.deletions)").foregroundStyle(AceTheme.StatusText.failed))
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            .accessibilityElement(children: .combine).accessibilityIdentifier("changes.totals")
        }
    }
    @ViewBuilder private func footer(_ summary: ChangesSummary) -> some View {
        if summary.hidden > 0 || summary.partial {
            Text(summary.partial ? "More files changed than one read returns. See them all on your computer."
                                 : "\(summary.hidden) more \(summary.hidden == 1 ? "file" : "files") on your computer")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(AceTheme.Spacing.lg)
        }
    }
}

/// A file's sticky header, as the web's: a faint caret and file glyph, the path muted in mono with
/// its name at full ink, its status word when it isn't a plain edit, "+N −N", and a box to tick
/// once it's been read.
struct ChangedFileHeader: View {
    let file: ChangesSummary.File
    let open: Bool
    let reviewed: Bool
    let toggle: () -> Void
    let review: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Button(action: toggle) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    AceIcon(.caretRight, size: 12)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: open)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                    AceIcon(.fileText, size: 14).foregroundStyle(AceTheme.Colours.subtleForeground)
                    path
                    if file.status != "modified" {
                        Text(file.status).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.subtleForeground).fixedSize()
                    }
                    Spacer(minLength: AceTheme.Spacing.xs)
                    counts
                }
                .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityValue(open ? "Open" : "Closed")
            .accessibilityIdentifier("changes.file.\(file.path)")
            Button(action: review) {
                AceIcon(reviewed ? .checkSquare : .square, size: 18)
                    .foregroundStyle(reviewed ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                    .frame(minWidth: 32, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: reviewed)
            .accessibilityLabel("Reviewed").accessibilityAddTraits(reviewed ? .isSelected : [])
            .accessibilityIdentifier("changes.reviewed.\(file.path)")
        }
        .padding(.leading, AceTheme.Spacing.lg).padding(.trailing, AceTheme.Spacing.sm)
        .opacity(reviewed ? 0.7 : 1)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: 1 / scale) }
    }
    private var path: some View {
        let folder = (file.path as NSString).deletingLastPathComponent
        let name = (file.path as NSString).lastPathComponent
        let moved = file.from.map { "\($0) → " } ?? ""
        return (Text(moved + (folder.isEmpty ? "" : folder + "/")).foregroundStyle(AceTheme.Colours.mutedForeground)
                + Text(name).foregroundStyle(AceTheme.Colours.foreground).fontWeight(.medium))
            .aceMonospace(FileDiffStyle.path, relativeTo: .footnote).lineLimit(1).truncationMode(.head)
    }
    /// "+41 −9": the only diff colour outside the diff itself.
    private var counts: some View {
        Group {
            if file.binary { Text("binary").foregroundStyle(AceTheme.Colours.subtleForeground) }
            else { Text("+\(file.additions)").foregroundStyle(AceTheme.StatusText.done) + Text(" −\(file.deletions)").foregroundStyle(AceTheme.StatusText.failed) }
        }
        .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit().fixedSize()
        .accessibilityLabel(file.binary ? "Binary" : "\(file.additions) added, \(file.deletions) removed")
    }
}
