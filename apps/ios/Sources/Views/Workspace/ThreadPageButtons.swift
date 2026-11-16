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

/// Chat and Changes in the thread's navigation bar, beside ⋯: a system bar button each, sized and
/// grouped in glass by iOS. The page showing is in full ink, the other muted. VoiceOver reads
/// each as a button, selected when it shows, with its words ("Changes, 6 files"). Put them in a
/// `ToolbarItemGroup`, so each is its own bar button.
struct ThreadPageButtons: View {
    let pages: ThreadPages
    let shown: ThreadPageKind
    let select: (ThreadPageKind) -> Void
    /// Hidden under the open drawer: still laid out, so the bar doesn't move.
    var hidden = false

    var body: some View {
        ForEach(pages.kinds) { kind in button(kind) }
    }

    private func button(_ kind: ThreadPageKind) -> some View {
        let chosen = kind == shown
        return Button { select(kind) } label: {
            Image(ace: kind.icon).barIcon()
                .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
        }
        .barGlyph()
        .opacity(hidden ? 0 : 1)
        .allowsHitTesting(!hidden)
        .accessibilityHidden(hidden)
        .accessibilityShowsLargeContentViewer {
            Image(ace: kind.icon)
            Text(pages.label(of: kind))
        }
        .accessibilityLabel(pages.label(of: kind))
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("thread.page.\(kind.rawValue)")
    }
}
