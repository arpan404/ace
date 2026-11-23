import SwiftUI

/// A Spade message's markdown, folded once finished when it draws past twenty lines (ADR 0212
/// amendment 2): its first twenty lines under a fade, then Show more, which opens the rest in place
/// with the system's own animation; Show less folds it again. Lines are the answer's line height
/// at the person's text size, so the fold follows Dynamic Type. Open stays open while the bubble
/// is on screen. A message the bridge doesn't mark `fold` is drawn as it is.
struct SpadeFoldedWords: View {
    let text: String
    var streaming = false
    /// The bridge's word: finished and long enough that it may draw past twenty lines.
    let fold: Bool
    @State private var open = false
    /// The words' drawn height, unfolded.
    @State private var drawn: CGFloat?
    @Environment(\.transcriptScale) private var scale
    @ScaledMetric(relativeTo: .body) private var lineHeight = AceDesign.TextRole.answer.lineHeight
    /// The web's and the bridge's twenty (`spadeFoldLines`).
    private static let lines: CGFloat = 20
    private var foldHeight: CGFloat { lineHeight * scale * Self.lines }

    var body: some View {
        if fold {
            folding
        } else {
            AceMarkdown(text: text, streaming: streaming)
        }
    }

    @ViewBuilder private var folding: some View {
        let long = (drawn ?? 0) > foldHeight + 1
        let folded = long && !open
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            // Full height, then clipped: the fold cuts the words rather than squeezing them.
            AceMarkdown(text: text, streaming: streaming)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { drawn = $0 }
                .frame(maxHeight: folded ? foldHeight : nil, alignment: .top)
                .clipped()
                // The last line fades, so a code block or table cut through reads as going on.
                .mask {
                    LinearGradient(stops: [.init(color: .black, location: folded ? 1 - 1 / Self.lines : 1),
                                           .init(color: folded ? .clear : .black, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                }
                .contentShape(Rectangle())
                // The words read as one element, all of them even while folded.
                .accessibilityElement(children: .combine)
            if long {
                Button(open ? "Show less" : "Show more") {
                    withAnimation { open.toggle() }
                }
                .buttonStyle(.plain)
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceDesign.Space.group)
                .contentShape(Rectangle())
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("spade.fold")
            }
        }
    }
}
