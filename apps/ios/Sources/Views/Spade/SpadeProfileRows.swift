import SwiftUI

/// A part with nothing in it, or one Spade couldn't read.
struct SpadeProfileNone: View {
    let text: String
    var failed = false
    var body: some View {
        Text(text)
            .aceFont(AceDesign.TextRole.meta)
            .foregroundStyle(failed ? AceTheme.StatusText.failed : AceDesign.Ink.subtle)
    }
}

/// A list's rows: its items and how many more stay on the computer, one line when there are
/// none, or that it couldn't be read, with Try again.
struct SpadeProfileRows<Item: Decodable & Equatable & Sendable & Hashable, Row: View>: View {
    let part: SpadeProfile.Part<Item>
    let none: String
    let failed: String
    let retry: () -> Void
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        if part.failed {
            HStack {
                SpadeProfileNone(text: failed, failed: true)
                Spacer(minLength: AceDesign.Space.related)
                Button("Try again", action: retry)
                    .aceFont(AceDesign.TextRole.meta)
                    .accessibilityIdentifier("spade.profile.retry")
            }
        } else {
            if part.items.isEmpty { SpadeProfileNone(text: none) }
            // By place: two notes may say the same thing.
            ForEach(Array(part.items.enumerated()), id: \.offset) { row($0.element) }
            if part.more > 0 { SpadeProfileNone(text: "\(part.more) more on the computer") }
        }
    }
}
