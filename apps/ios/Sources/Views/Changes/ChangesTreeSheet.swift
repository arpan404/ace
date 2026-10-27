import SwiftUI

/// The changed files as folders: tap a folder to fold it, a file to open its diff and jump to it.
/// Each row carries its lines added and removed.
struct ChangesTreeSheet: View {
    @Bindable var model: ClientModel
    let reveal: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var folded: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            List {
                ForEach(visible) { row in
                    Button { tap(row) } label: { label(row) }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowBackground(AceTheme.Colours.background)
                        .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.lg, bottom: 0, trailing: AceTheme.Spacing.lg))
                        .accessibilityIdentifier("tree.\(row.key)")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .animation(reduceMotion ? nil : .smooth(duration: AceTheme.Motion.standard), value: folded)
            .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    /// Rows under folded folders are hidden.
    private var visible: [ChangesTreeRow] {
        var out: [ChangesTreeRow] = []
        var hiddenBelow: Int?
        for row in model.sheets.tree {
            if let depth = hiddenBelow {
                if row.depth > depth { continue }
                hiddenBelow = nil
            }
            out.append(row)
            if row.kind == "folder", folded.contains(row.key) { hiddenBelow = row.depth }
        }
        return out
    }

    private func tap(_ row: ChangesTreeRow) {
        if row.kind == "folder" {
            if folded.contains(row.key) { folded.remove(row.key) } else { folded.insert(row.key) }
            UISelectionFeedbackGenerator().selectionChanged()
        } else {
            dismiss()
            reveal(row.key)
        }
    }

    private func label(_ row: ChangesTreeRow) -> some View {
        let folder = row.kind == "folder"
        let viewed = model.sheets.changes?.files.first { $0.path == row.key }?.viewed == true
        return HStack(spacing: AceTheme.Spacing.sm) {
            Color.clear.frame(width: CGFloat(row.depth) * 16, height: 1)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                .rotationEffect(.degrees(folder && !folded.contains(row.key) ? 90 : 0))
                .foregroundStyle(AceTheme.Colours.decoration).frame(width: 10).opacity(folder ? 1 : 0)
            Text(row.name).aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(folder || viewed ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                .lineLimit(1).truncationMode(.middle)
            if viewed { Text("Viewed").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground) }
            Spacer(minLength: AceTheme.Spacing.sm)
            HStack(spacing: AceTheme.Spacing.xs) {
                Text("−\(row.deletions)").foregroundStyle(AceTheme.StatusText.failed)
                Text("+\(row.additions)").foregroundStyle(AceTheme.StatusText.done)
            }
            .aceMonospace(FileDiffStyle.path, relativeTo: .caption).opacity(folder ? 0.7 : 1)
        }
        .frame(minHeight: 44).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(folder ? (folded.contains(row.key) ? "Folded" : "Open") : "")
    }
}
