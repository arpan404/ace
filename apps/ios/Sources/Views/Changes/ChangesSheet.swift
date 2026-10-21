import SwiftUI

/// The thread's uncommitted changes for review: each file under a sticky header (open it for its
/// diff, tick it off once read), and the next git step in the ⋯ menu. Steps go through the
/// daemon's guarded git; a view-only phone sees the diff but not the steps. The bridge sends one
/// file's diff at a time, so opening a file closes the one before.
struct ChangesSheet: View {
    @Bindable var model: ClientModel
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var open: String?
    @State private var reviewed: Set<String> = []
    @State private var wrap = true
    private var summary: ChangesSummary? { model.sheets.changes }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none, pinnedViews: [.sectionHeaders]) {
                    content
                }
            }
            .background(AceTheme.Colours.background)
            .refreshable { model.sheet(["kind": "changes.refresh"]) }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("changes.close")
                }
                ToolbarItem(placement: .principal) { header }
            }
            .changesActions(model: model, summary: summary, title: title, wrap: $wrap)
        }
        .tint(AceTheme.Colours.foreground)
        .onAppear { model.sheet(["kind": "changes", "open": true]) }
        .onDisappear { model.sheet(["kind": "changes", "open": false]) }
        .onChange(of: summary?.files.first?.path) { _, first in if open == nil, let first { show(first) } }
    }

    @ViewBuilder private var content: some View {
        if let summary {
            if summary.state == "error" {
                ContentUnavailableView("Couldn't read changes", systemImage: "exclamationmark.triangle",
                                       description: Text("Check that this thread has a git checkout, then refresh."))
                    .padding(.top, AceTheme.Spacing.xxxl)
            } else if summary.state == "loading" && summary.files.isEmpty {
                ProgressView("Reading changes…").frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
            } else if summary.files.isEmpty {
                ContentUnavailableView("No uncommitted changes", systemImage: "checkmark.circle").padding(.top, AceTheme.Spacing.xxxl)
            } else {
                ForEach(summary.files) { file in
                    Section {
                        if open == file.path { FileDiffRows(model: model, path: file.path, wrap: wrap) }
                    } header: {
                        ChangedFileHeader(file: file, open: open == file.path, reviewed: reviewed.contains(file.path),
                                          toggle: { open == file.path ? show(nil) : show(file.path) },
                                          review: { if reviewed.contains(file.path) { reviewed.remove(file.path) } else { reviewed.insert(file.path) } })
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

    /// "Changes on fix/queue" over "+42 · −8 · 4 files".
    private var header: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Text("Changes")
                .aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1).truncationMode(.middle)
            if let totals = summary?.totals, totals.files > 0 {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text("+\(totals.additions)").foregroundStyle(AceTheme.StatusText.done)
                    Text("·")
                    Text("−\(totals.deletions)").foregroundStyle(AceTheme.StatusText.failed)
                    Text("· \(totals.files) \(totals.files == 1 ? "file" : "files")")
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .accessibilityElement(children: .combine).accessibilityIdentifier("changes.totals")
            }
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

/// A file's sticky 52pt header: disclosure, status mark, the path in mono with its name in bold,
/// −N +N, and a box to tick once it's been read.
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
                        .animation(reduceMotion ? nil : .easeOut(duration: AceTheme.Motion.standard), value: open)
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
                    .frame(minWidth: 32, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: reviewed)
            .accessibilityLabel("Reviewed").accessibilityAddTraits(reviewed ? .isSelected : [])
            .accessibilityIdentifier("changes.reviewed.\(file.path)")
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
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
        RoundedRectangle(cornerRadius: 6).stroke(colour, lineWidth: 1.5)
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
        case "renamed": AceTheme.StatusText.working
        default: AceTheme.StatusText.done
        }
    }
    private var symbol: String {
        switch status {
        case "deleted": "minus"
        case "renamed": "arrow.right"
        default: "plus"
        }
    }
}
