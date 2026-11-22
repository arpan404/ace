import SwiftUI

/// What the next message replies to, as one chip beside the composer's other chips: “Replying to
/// “double as the guard”” or “Replying to 3 quotes”. Each passage goes to the agent before the
/// words, with the message around it. Tap for each passage and Remove, and Remove all.
struct QuoteChips: View {
    let items: [QuoteChip]
    let remove: (String) -> Void
    let clear: () -> Void

    /// “Replying to “the guard””, “Replying to 3 quotes”.
    static func label(_ items: [QuoteChip]) -> String {
        if items.count == 1, let only = items.first { return "Replying to “\(only.text.replacingOccurrences(of: "\n", with: " "))”" }
        return "Replying to \(items.count) quotes"
    }

    var body: some View {
        Menu {
            Section {
                ForEach(items) { item in
                    Button("Remove “\(item.text)”", ace: .x, role: .destructive) { remove(item.id) }
                }
            }
            if items.count > 1 {
                Button("Remove all", ace: .x, role: .destructive, action: clear)
            }
        } label: { chip }
        .sensoryFeedback(.selection, trigger: items.count)
        .accessibilityIdentifier("composer.quotes")
    }

    private var chip: some View {
        Text(Self.label(items))
            .font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.primary)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: AceDesign.Size.popover, alignment: .leading)
            .padding(.horizontal, AceDesign.Space.row)
            .frame(minHeight: AceDesign.Size.slimControl)
            .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
            .frame(minHeight: AceDesign.Size.tap)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.label(items))
            .accessibilityHint("Goes to the agent before your message, so it knows what you're answering")
    }
}

/// The editor's notes on code for the next message, as one chip beside the quotes: “Note on
/// total.ts:2–3” or “3 code notes”. Each goes to the agent after the words, by `path:lines` with
/// its code and the note. Tap for each note and Remove, and Remove all.
struct CodeNoteChips: View {
    let items: [CodeNote]
    let remove: (String) -> Void
    let clear: () -> Void

    /// "total.ts:2–3".
    static func place(_ note: CodeNote) -> String {
        let name = note.path.split(separator: "/").last.map(String.init) ?? note.path
        let lines = note.lines
        return lines.count == 1 ? "\(name):\(lines.lowerBound)" : "\(name):\(lines.lowerBound)–\(lines.upperBound)"
    }
    /// “Note on total.ts:2–3”, “3 code notes”.
    static func label(_ items: [CodeNote]) -> String {
        if items.count == 1, let only = items.first { return "Note on \(place(only))" }
        return "\(items.count) code notes"
    }

    var body: some View {
        Menu {
            Section {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    Button("Remove \(index + 1) · \(Self.place(item))\(item.comment.isEmpty ? "" : ": \(item.comment)")", ace: .x, role: .destructive) { remove(item.id) }
                }
            }
            if items.count > 1 {
                Button("Remove all", ace: .x, role: .destructive, action: clear)
            }
        } label: {
            Text(Self.label(items))
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: AceDesign.Size.popover, alignment: .leading)
                .padding(.horizontal, AceDesign.Space.row)
                .frame(minHeight: AceDesign.Size.slimControl)
                .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
                .frame(minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.label(items))
                .accessibilityHint("Goes to the agent after your message, with the code each note is on")
        }
        .sensoryFeedback(.selection, trigger: items.count)
        .accessibilityIdentifier("composer.codeNotes")
    }
}
