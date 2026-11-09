import SwiftUI

extension ThreadPageKind {
    /// The page's glyph in the thread's bar.
    var icon: AceIcon.Name {
        switch self {
        case .chat: .chatCircle
        case .changes: .plusMinus
        }
    }
}

/// Chat and Changes as one small switch in the thread's navigation bar, beside ⋯: a glyph each,
/// the page showing in full ink on the raised fill the Threads tabs use, the other muted. The
/// fill slides to the page showing, a tap's or a swipe's. VoiceOver reads each as a button,
/// selected when it shows, with its words ("Changes, 6 files").
struct ThreadPageButtons: View {
    let pages: ThreadPages
    let shown: ThreadPageKind
    let select: (ThreadPageKind) -> Void
    @Namespace private var fill

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(pages.kinds) { kind in button(kind) }
        }
        .animation(.default, value: shown)
    }

    private func button(_ kind: ThreadPageKind) -> some View {
        let chosen = kind == shown
        return Button { select(kind) } label: {
            AceIcon(kind.icon, size: AceDesign.Size.navGlyph + 1)
                .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .frame(width: AceDesign.Size.pill + 2, height: AceDesign.Size.pill)
                .background {
                    if chosen {
                        AceShape.capsule.fill(AceDesign.Surface.raised)
                            .shadow(color: .black.opacity(AceShadow.tabOpacity), radius: AceShadow.tabRadius, y: AceShadow.tabY)
                            .matchedGeometryEffect(id: "chosen", in: fill)
                    }
                }
                .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pages.label(of: kind))
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("thread.page.\(kind.rawValue)")
    }
}
