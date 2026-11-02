import SwiftUI

/// A status in words (the web's `StatusLabel` and row status): a small glyph, the shared word
/// ("Approve", "Working", "Failed") and, for live work, how long it has run. Only what needs
/// the person is `loud`: the word takes its tone's colour, semibold. Everything else reads
/// in muted ink at regular weight while its glyph keeps the hue, small. Colour is never the only
/// clue: the word is always there.
struct StatusLabel: View {
    let word: String
    let tone: AceTone
    /// Nil draws the word alone (waiting is only words).
    var glyph: GlyphState?
    var loud = false
    var elapsed: String?
    var live = false

    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            if let glyph { StatusGlyph(glyph, tone: tone, live: live) }
            Text(word).fontWeight(loud ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            if let elapsed { Text(elapsed).monospacedDigit() }
        }
        .font(AceDesign.Typeface.meta)
        .foregroundStyle(loud ? tone.text : AceDesign.Ink.muted)
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}
