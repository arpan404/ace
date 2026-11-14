import CoreGraphics

/// How the thread's bar shares its width. UIKit measures the title at the width it's given and
/// can't shrink it, so when the title and the trailing buttons together are wider than the bar,
/// UIKit folds the trailing buttons, ⋯ with them, into its "More" button. To avoid that, the
/// title takes only what is left after every trailing button, and Chat and Changes stay beside ⋯
/// only while the title keeps a readable width. Otherwise they move into ⋯
/// (`ThreadDestination.menuScreens`). The bar's glyphs keep their default size at every text
/// size (`barGlyph()`), so these widths hold at every text size.
struct ThreadBarLayout: Equatable {
    /// The narrowest title kept beside Chat and Changes: three buttons' worth.
    static let minimumTitle: CGFloat = 3 * AceDesign.Size.tap

    /// Chat and Changes sit beside ⋯; false puts them in ⋯.
    let switchInBar: Bool
    /// The width the title is given.
    let headingWidth: CGFloat

    /// - Parameters:
    ///   - pages: the thread's pages a switch would show (0 beside the iPad's side panel).
    ///   - largeText: an accessibility text size, where the title needs all the room it can get.
    init(pageWidth: CGFloat, leadingTitle: Bool, panel: Bool, pages: Int, largeText: Bool) {
        let buttons = CGFloat(1 + (panel ? 1 : 0)) * AceDesign.Size.tap
        let without = Self.heading(pageWidth: pageWidth, leading: leadingTitle, trailing: buttons)
        guard pages > 1, !largeText else {
            switchInBar = false
            headingWidth = without
            return
        }
        // A glyph per page and the glass's inset around them, then the gap that groups them with ⋯.
        let pageSwitch = CGFloat(pages) * (AceDesign.Size.pill + 2) + 2 * AceDesign.Space.related
        let beside = Self.heading(pageWidth: pageWidth, leading: leadingTitle, trailing: buttons + pageSwitch)
        switchInBar = beside >= Self.minimumTitle
        headingWidth = switchInBar ? beside : without
    }

    /// Leading, the title takes everything between the back button and the trailing buttons,
    /// with the bar's insets on both sides. Centred, it gets the width between the wider side's
    /// buttons, mirrored, and no more than five buttons' worth.
    private static func heading(pageWidth: CGFloat, leading: Bool, trailing: CGFloat) -> CGFloat {
        let margins = 2 * AceDesign.Space.margin
        if leading {
            return max(0, pageWidth - margins - AceDesign.Size.tap - trailing - 4 * AceDesign.Space.related)
        }
        return max(0, min(AceDesign.Size.tap * 5, pageWidth - 2 * trailing - margins))
    }
}

extension ThreadDestination {
    /// The screens in the ⋯ panel's grid, in order. Beside the iPad's side panel: Changes, Files,
    /// Terminal and Browser, opening as its tabs. On a phone: Files and Terminal (a thread with a
    /// checkout), Browser and Agents, each pushed, led by the page not showing when Chat and
    /// Changes have moved from the bar into ⋯.
    static func menuScreens(pages: ThreadPages?, shown: ThreadPageKind, switchInBar: Bool) -> [ThreadDestination] {
        guard let pages else { return [.changes, .files, .terminal, .browser] }
        let page: [ThreadDestination] = switchInBar || pages.kinds.count < 2 ? [] : [shown == .chat ? .changes : .chat]
        return page + (pages.checkout ? [.files, .terminal] : []) + [.browser, .agents]
    }
}
