import SwiftUI

/// The thread's uncommitted changes with their line counts, each file's diff, and the next git
/// step the web offers. Steps go through the daemon's guarded git; a view-only phone sees the
/// diff but not the step's button.
struct ChangesSheet: View {
    @Bindable var model: ClientModel
    let title: String
    @Environment(\.dismiss) private var dismiss
    private var summary: ChangesSummary? { model.sheets.changes }

    var body: some View {
        NavigationStack {
            List {
                if let summary {
                    if summary.state == "error" {
                        ContentUnavailableView("Couldn't read changes", systemImage: "exclamationmark.triangle",
                                               description: Text("Check that this thread has a git checkout, then refresh."))
                    } else if summary.state == "loading" && summary.files.isEmpty {
                        ProgressView("Reading changes…").frame(maxWidth: .infinity)
                    } else if summary.files.isEmpty {
                        ContentUnavailableView("No uncommitted changes", systemImage: "checkmark.circle")
                    } else {
                        Section { ForEach(summary.files) { file in NavigationLink(value: file.path) { ChangedFileRow(file: file) } } }
                        footer(summary)
                    }
                } else {
                    ProgressView("Reading changes…").frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { model.sheet(["kind": "changes.refresh"]) }
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { path in FileDiffView(model: model, path: path) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .principal) { header }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                if let summary, summary.state == "ready" { NextStepCard(model: model, summary: summary, title: title) }
            }
        }
        .onAppear { model.sheet(["kind": "changes", "open": true]) }
        .onDisappear { model.sheet(["kind": "changes", "open": false]) }
    }
    private var header: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Text("Changes").aceFont(AceTheme.Typography.title, relativeTo: .headline)
            if let totals = summary?.totals, totals.files > 0 {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text("\(totals.files) \(totals.files == 1 ? "file" : "files") ·")
                    Text("+\(totals.additions)").foregroundStyle(AceTheme.StatusText.done)
                    Text("−\(totals.deletions)").foregroundStyle(AceTheme.StatusText.failed)
                }
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                .accessibilityElement(children: .combine).accessibilityIdentifier("changes.totals")
            }
        }
    }
    @ViewBuilder private func footer(_ summary: ChangesSummary) -> some View {
        if summary.hidden > 0 || summary.partial {
            Text(summary.partial ? "More files changed than one read returns. See them all on your computer."
                                 : "\(summary.hidden) more \(summary.hidden == 1 ? "file" : "files") on your computer")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }
}

struct ChangedFileRow: View {
    let file: ChangesSummary.File
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(file.path).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2).truncationMode(.head)
                if let from = file.from { Text("from \(from)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1) }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if file.binary { Text("binary").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            if file.deletions > 0 { Text("−\(file.deletions)").foregroundStyle(AceTheme.StatusText.failed) }
            if file.additions > 0 { Text("+\(file.additions)").foregroundStyle(AceTheme.StatusText.done) }
        }
        .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("changes.file.\(file.path)")
    }
}
