import SwiftUI
import UIKit

enum FileConflictReview: Identifiable {
    case compare(FileComparison)
    case merge(FileMerge, path: String, draft: String)

    var id: String {
        switch self {
        case .compare: "compare"
        case .merge: "merge"
        }
    }
}

extension FileScreen {
    private enum ConflictAction: String { case compare, merge }

    func conflictStrip(_ version: String) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Text(problem ?? (conflictBusy ? "Reading the current file…" : "\(name) changed on the machine."))
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .accessibilityIdentifier("files.strip")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AceTheme.Spacing.sm) { conflictActions(version) }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) { conflictActions(version) }
            }
        }
        .foregroundStyle(AceTheme.Colours.foreground)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(AceTheme.Spacing.md)
        .floatingGlass()
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.sm)
    }

    @ViewBuilder private func conflictActions(_ version: String) -> some View {
        Button("Merge") { reviewConflict(.merge, at: version) }
            .buttonStyle(.textAction(.prominent))
            .disabled(conflictBusy)
        Button("Compare") { reviewConflict(.compare, at: version) }
            .buttonStyle(.textAction())
            .disabled(conflictBusy)
        Button("Keep editing") {
            cancelConflictRead()
            conflict = nil
            problem = nil
        }
        .buttonStyle(.textAction())
        Button("Replace", role: .destructive) { save(over: version) }
            .buttonStyle(.textAction(.destructive))
            .disabled(conflictBusy)
    }

    @ViewBuilder func showConflict(_ review: FileConflictReview) -> some View {
        switch review {
        case .compare(let comparison):
            FileComparisonSheet(comparison: comparison)
        case .merge(let merge, let requestPath, let draft):
            FileMergeSheet(merge: merge, path: requestPath) { text in
                guard holdsDraft(draft, at: requestPath) else {
                    problem = "Your draft changed. Merge again to include your latest edits."
                    return
                }
                rebaseEdit(onto: merge.disk, text: text)
            }
        }
    }

    private func holdsDraft(_ draft: String, at requestPath: String) -> Bool {
        editing && path == requestPath && handle.view != nil && handle.text.utf8.elementsEqual(draft.utf8)
    }

    func cancelConflictRead() {
        conflictTask?.cancel()
        conflictTask = nil
    }

    private func reviewConflict(_ action: ConflictAction, at version: String) {
        guard !conflictBusy, !saving, let view = handle.view else { return }
        let requestPath = path
        let draft = view.text ?? ""
        var request: [String: Any] = ["op": action.rawValue, "path": requestPath, "text": draft]
        if action == .merge {
            // Auto save may have moved the base since the file opened: merge from what it wrote.
            guard let original = autoSaved?.text ?? content?.text else { return }
            request["base"] = original
        }
        problem = nil
        view.resignFirstResponder()
        conflictTask = Task {
            defer { if !Task.isCancelled { conflictTask = nil } }
            do {
                let review: FileConflictReview
                switch action {
                case .merge:
                    let merge = try await model.files(scope, request, as: FileMerge.self)
                    review = .merge(merge, path: requestPath, draft: draft)
                case .compare:
                    review = .compare(try await model.files(scope, request, as: FileComparison.self))
                }
                guard !Task.isCancelled, conflict == version, editing, handle.view != nil, path == requestPath else { return }
                guard holdsDraft(draft, at: requestPath) else {
                    problem = "Your draft changed. Try again to include your latest edits."
                    return
                }
                conflictReview = review
            } catch {
                if !Task.isCancelled, conflict == version { problem = error.localizedDescription }
            }
        }
    }
}

private struct FileComparisonSheet: View {
    let comparison: FileComparison
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    if !comparison.rows.isEmpty {
                        ForEach(comparison.rows) { row in
                            ChangesLineRow(row: row, wrap: true, selected: false, tap: nil, wholeLine: {})
                        }
                    } else if !comparison.finalNewlineChanged {
                        note("Your draft matches the file on the machine.")
                    }
                    if comparison.finalNewlineChanged { note("The final line break differs.") }
                }
            }
            .navigationTitle("Machine → Your draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(AceDesign.Space.margin)
    }
}

private struct FileMergeSheet: View {
    let merge: FileMerge
    let path: String
    let apply: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choices: [Int: FileMerge.Choice] = [:]
    @State private var handle = SourceHandle()

    var body: some View {
        let overlaps = merge.overlaps
        NavigationStack {
            Group {
                if overlaps.isEmpty, let text = merge.resolved([:]) {
                    SourceTextView(document: SourceDocument(key: path, text: text, language: merge.disk.language, marks: [:]),
                                   wrap: true, editable: false, line: nil, handle: handle)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                            ForEach(Array(overlaps.enumerated()), id: \.element.id) { index, overlap in
                                overlapBlock(overlap, index: index)
                            }
                        }
                        .padding(AceDesign.Space.margin)
                    }
                }
            }
            .navigationTitle(overlaps.isEmpty ? "Review merge" : "Overlapping changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        guard let text = merge.resolved(choices) else { return }
                        apply(text)
                        dismiss()
                    }
                    .disabled(choices.count != overlaps.count)
                }
            }
        }
    }

    private func overlapBlock(_ overlap: FileMerge.Overlap, index: Int) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Text("Overlap \(index + 1)").aceFont(AceDesign.TextRole.rowTitle)
                .accessibilityAddTraits(.isHeader)
            side(overlap.mine, chosen: choices[overlap.id] == .mine, title: "Keep mine") {
                choices[overlap.id] = .mine
            }
            side(overlap.theirs, chosen: choices[overlap.id] == .theirs, title: "Take theirs") {
                choices[overlap.id] = .theirs
            }
        }
    }

    private func side(_ text: String, chosen: Bool, title: String, choose: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Text(text.isEmpty ? "No lines" : text)
                .aceMonospace(AceDesign.TextRole.code)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(AceTheme.Spacing.md)
                .background(AceDesign.Surface.band)
            Button(title, action: choose)
                .buttonStyle(.textAction(chosen ? .prominent : .plain))
                .accessibilityAddTraits(chosen ? .isSelected : [])
        }
    }
}
