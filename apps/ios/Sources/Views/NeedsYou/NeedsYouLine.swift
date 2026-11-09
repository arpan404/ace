import SwiftUI

/// The top of the Threads list while anything waits on the person: one quiet line, "3 need you",
/// and Review, which starts the needs-you run. Words, not chrome: no card, no badge.
struct NeedsYouLine: View {
    let words: String
    let review: () -> Void
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(words)
                .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.foreground)
                .monospacedDigit()
                .contentTransition(.numericText())
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Review", action: review)
                .buttonStyle(NeedWordStyle(primary: true))
                .accessibilityIdentifier("inbox.needs.review")
        }
        .padding(.leading, AceDesign.Size.rowInset)
        // Review's word ends where the rows' words end.
        .padding(.trailing, AceDesign.Size.rowInset - AceDesign.Space.stripWord)
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(words)
        .accessibilityHint("Goes through each request")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { review() }
        .accessibilityIdentifier("inbox.needs")
    }
}
