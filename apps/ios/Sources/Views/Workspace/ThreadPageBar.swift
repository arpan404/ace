import SwiftUI

/// The thread's pages under its title: one capsule per page, words only, the page showing on the
/// selected fill that slides between them, Changes with a quiet count of the files. It scrolls
/// sideways when the pages don't fit, keeping the page showing in view. Taps land over 44 points.
struct ThreadPageBar: View {
    let pages: ThreadPages
    let shown: ThreadPageKind
    let select: (ThreadPageKind) -> Void
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Namespace private var fill

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.none) {
                    ForEach(pages.kinds) { kind in pill(kind).id(kind) }
                }
                .padding(.horizontal, AceDesign.Space.margin - AceDesign.Space.chipTab)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .onChange(of: shown, initial: true) { _, page in
                withAnimation(AceDesign.Motion.arriving(reduceMotion)) { proxy.scrollTo(page, anchor: .center) }
            }
        }
        .frame(height: AceDesign.Size.tap)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Thread pages")
        .accessibilityIdentifier("thread.pages")
    }

    private func pill(_ kind: ThreadPageKind) -> some View {
        let chosen = kind == shown
        let count = pages.count(of: kind)
        return Button { select(kind) } label: {
            HStack(spacing: AceDesign.Space.tight + 1) {
                Text(kind.title).lineLimit(1)
                if let count {
                    Text(count.formatted()).monospacedDigit()
                        .aceFont(AceDesign.TextRole.time, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
            .fontWeight(chosen ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceDesign.Space.chipTab)
            .frame(height: AceDesign.Size.pill)
            .background {
                if chosen {
                    AceShape.capsule.fill(AceDesign.Surface.fill)
                        .matchedGeometryEffect(id: "chosen", in: fill)
                }
            }
            .contentShape(AceShape.capsule)
            .tapBand(drawn: AceDesign.Size.pill)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count.map { "\(kind.title), \($0) \($0 == 1 ? "file" : "files")" } ?? kind.title)
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("thread.page.\(kind.rawValue)")
    }
}
