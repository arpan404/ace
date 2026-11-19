import SwiftUI

/// A quiet heading alone, over a control that heads its own group (a glass choice, a picker).
struct QuietHeading: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).aceFont(AceDesign.TextRole.meta)
            .foregroundStyle(AceDesign.Ink.subtle)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A heading, its field on the page itself, and the hairline under it that starts at the margin:
/// no filled box, as the design language's sheets draw a field.
struct QuietField<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            QuietHeading(title).padding(.horizontal, AceDesign.Space.margin)
            content().padding(.horizontal, AceDesign.Space.margin)
            Hairline().padding(.leading, AceDesign.Space.margin)
        }
    }
}
