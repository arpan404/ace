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
