import SwiftUI

/// Spade's composer capsule: the field, and Send. While a reply is open a message steers it;
/// while Spade isn't running the field says why and nothing sends.
struct SpadeComposer: View {
    @Binding var text: String
    let placeholder: String
    /// Why nothing can be sent now; nil when Spade is running.
    let blocked: String?
    let sending: Bool
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.none) {
            TextField(blocked ?? placeholder, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .focused($focused)
                .disabled(blocked != nil)
                .padding(.leading, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
                .frame(minHeight: AceDesign.Size.tap)
                .accessibilityIdentifier("spade.composer")
            ComposerActionButton(saving: sending, disabled: empty || blocked != nil || sending, label: "Send", action: send)
                .padding(.trailing, AceDesign.Space.tight)
                .padding(.bottom, AceTheme.Spacing.xxs)
                .accessibilityIdentifier("spade.send")
        }
        .composerGlass(in: AceShape.field)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: sending) { _, now in now }
    }
}
