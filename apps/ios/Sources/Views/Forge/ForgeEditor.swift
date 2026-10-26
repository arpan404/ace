import SwiftUI

/// A multi-line text field for GitHub text, in the theme's body type. With a completer, an `@`
/// or `#` word at the caret lists people or issues and pull requests under the field (decided by
/// the bridge, `forge.complete`); a pick replaces the word and leaves the caret after it.
struct ForgeEditor: View {
    @Binding var text: String
    let placeholder: String
    var minLines = 1
    var maxLines = 12
    var completer: ForgeCompleter?
    @State private var selection: TextSelection?
    @State private var suggestions: [ForgeCompletions.Item] = []

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            TextField(placeholder, text: $text, selection: $selection, axis: .vertical)
                .lineLimit(minLines...max(minLines, maxLines))
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .padding(AceTheme.Spacing.md)
                .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
                .accessibilityIdentifier("forge.editor")
            if !suggestions.isEmpty { list }
        }
        .task(id: "\(text)|\(caret.map { "\($0.start):\($0.end)" } ?? "")") { await suggest() }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach(suggestions, id: \.self) { item in
                Button { pick(item) } label: {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        Text(item.label).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
                        Text(item.detail).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                        Spacer(minLength: AceTheme.Spacing.none)
                    }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .padding(.horizontal, AceTheme.Spacing.md)
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.row)
                .accessibilityIdentifier("forge.suggestion.\(item.label)")
                Divider().overlay(AceTheme.Colours.separator)
            }
        }
    }

    /// The selection in UTF-16 offsets, as the bridge counts them; nil while nothing is selected.
    private var caret: (start: Int, end: Int)? {
        guard case .selection(let range) = selection?.indices,
              range.lowerBound <= text.endIndex, range.upperBound <= text.endIndex else { return nil }
        let utf16 = text.utf16
        return (utf16.distance(from: utf16.startIndex, to: range.lowerBound), utf16.distance(from: utf16.startIndex, to: range.upperBound))
    }

    private func suggest() async {
        guard let completer, let caret, text.contains("@") || text.contains("#") else { suggestions = []; return }
        // Typing settles before GitHub is asked; a newer key cancels this one.
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        let items = await completer.suggestions(text: text, start: caret.start, end: caret.end)
        if !Task.isCancelled { suggestions = items }
    }

    private func pick(_ item: ForgeCompletions.Item) {
        let utf16 = text.utf16
        guard item.from <= item.to, item.to <= utf16.count,
              let from = utf16.index(utf16.startIndex, offsetBy: item.from, limitedBy: utf16.endIndex),
              let to = utf16.index(utf16.startIndex, offsetBy: item.to, limitedBy: utf16.endIndex) else { return }
        let next = String(text[..<from]) + item.insert + String(text[to...])
        text = next
        let at = next.utf16.index(next.utf16.startIndex, offsetBy: min(item.caret, next.utf16.count))
        selection = TextSelection(insertionPoint: at)
        suggestions = []
    }
}
