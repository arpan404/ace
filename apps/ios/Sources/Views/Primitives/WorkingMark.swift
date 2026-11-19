import SwiftUI

/// Work in progress beside a row or a word: the still working glyph (design language §2 "Still,
/// not busy"), never a spinner.
struct WorkingMark: View {
    var label = "Working"
    var body: some View {
        StatusGlyph(.working, tone: .working, size: AceDesign.Size.icon)
            .accessibilityElement()
            .accessibilityLabel(label)
    }
}
