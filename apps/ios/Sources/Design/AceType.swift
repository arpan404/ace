import SwiftUI
import UIKit

extension AceDesign {
    /// A text role: one of the system's text styles at that style's own default size, with ace's
    /// weight and line height. Scaled against its own style, so Dynamic Type grows it exactly as it
    /// grows the system's text.
    struct Role: Sendable {
        let textStyle: Font.TextStyle
        let uiTextStyle: UIFont.TextStyle
        let style: AceTheme.TypeStyle

        var size: CGFloat { style.size }
        var lineHeight: CGFloat { style.lineHeight }
        var weight: CGFloat { style.weight }

        init(_ textStyle: Font.TextStyle, _ uiTextStyle: UIFont.TextStyle, size: CGFloat, lineHeight: CGFloat, weight: CGFloat = 400) {
            self.textStyle = textStyle
            self.uiTextStyle = uiTextStyle
            style = AceTheme.TypeStyle(size: size, lineHeight: lineHeight, weight: weight, tracking: 0)
        }
    }

    /// The type scale: iOS's own text styles at their default sizes (large title 34, headline and
    /// body 17, subheadline 15, footnote 13, caption 12, caption 2 11). SF Pro with the system's
    /// own tracking; nothing is drawn bigger than its role.
    enum TextRole {
        /// The home screen's own title ("ace ⌄"), a page's name in its header. Headline.
        static let header = Role(.headline, .headline, size: 17, lineHeight: 22, weight: 600)
        /// An open thread's title in its bar. Headline, as the system's inline titles.
        static let navTitle = Role(.headline, .headline, size: 17, lineHeight: 22, weight: 600)
        /// "project · branch" under it. Caption, as the system's bar subtitle.
        static let navSubtitle = Role(.caption, .caption1, size: 12, lineHeight: 16)
        /// The person's message, in its bubble. Body.
        static let message = Role(.body, .body, size: 17, lineHeight: 22)
        /// The agent's answer: body, its lines a little more open.
        static let answer = Role(.body, .body, size: 17, lineHeight: 25)
        /// A row's title (a thread, a chat), a grouped row's label, the composer's words. Body.
        static let rowTitle = Role(.body, .body, size: 17, lineHeight: 22)
        /// A request strip's sentence, and the segmented control's words. Subheadline.
        static let segment = Role(.subheadline, .subheadline, size: 15, lineHeight: 20)
        /// A strip's actions, a grouped row's value. Subheadline.
        static let action = Role(.subheadline, .subheadline, size: 15, lineHeight: 20)
        /// A transcript step ("Edited …"). Footnote.
        static let step = Role(.footnote, .footnote, size: 13, lineHeight: 18)
        /// Project, the scope under a title, "Worked for", a section label. Footnote.
        static let meta = Role(.footnote, .footnote, size: 13, lineHeight: 18)
        /// A row's time, a count, a chip's words. Caption.
        static let time = Role(.caption, .caption1, size: 12, lineHeight: 16)
        /// Code in a step or a strip. Caption, in mono.
        static let code = Role(.caption, .caption1, size: 12, lineHeight: 16)
        /// A row's last line: branch (mono), pull request, lines changed. Caption 2.
        static let branch = Role(.caption2, .caption2, size: 11, lineHeight: 13)
        /// Tiny labels. Caption 2.
        static let caption = Role(.caption2, .caption2, size: 11, lineHeight: 13)
    }
}

extension AceDesign.Role {
    /// The role's font for UIKit text, scaled for `traits`.
    @MainActor func uiFont(traits: UITraitCollection) -> UIFont {
        AceTheme.uiFont(style, relativeTo: uiTextStyle, traits: traits)
    }
}

extension View {
    /// Text in `role`, scaled with Dynamic Type along the role's own text style.
    @MainActor func aceFont(_ role: AceDesign.Role) -> some View {
        aceFont(role.style, relativeTo: role.textStyle)
    }
    /// Code, commands, paths and branches in `role`, in mono.
    @MainActor func aceMonospace(_ role: AceDesign.Role) -> some View {
        aceMonospace(role.style, relativeTo: role.textStyle)
    }
    /// The role's own text style always wins: `relativeTo` is ignored. Kept only for the views
    /// that still pass one; new code names the role alone.
    @MainActor func aceFont(_ role: AceDesign.Role, relativeTo _: Font.TextStyle) -> some View {
        aceFont(role)
    }
    @MainActor func aceMonospace(_ role: AceDesign.Role, relativeTo _: Font.TextStyle) -> some View {
        aceMonospace(role)
    }
}
