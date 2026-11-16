import SwiftUI
import UIKit

extension AceDesign {
    /// A text role: one of the system's text styles at that style's own default size, with ace's
    /// weight and line height. Drawn at the system's own size for that style, so Dynamic Type grows
    /// it exactly as it grows the system's text.
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
    /// The role's size at `category`: the system's own point size for its text style, read from
    /// UIKit rather than scaled from the default size, since `UIFontMetrics` and `@ScaledMetric`
    /// only approximate the system's table (13pt footnote reaches 17 at XXXL where iOS draws 19).
    @MainActor func pointSize(at category: UIContentSizeCategory) -> CGFloat {
        AceRoleSizes.pointSize(uiTextStyle, category)
    }
    /// The role's line height at `category`, grown in step with its size.
    @MainActor func lineHeight(at category: UIContentSizeCategory) -> CGFloat {
        lineHeight * pointSize(at: category) / size
    }
    /// The role's font for UIKit text, at the size category in `traits`.
    @MainActor func uiFont(traits: UITraitCollection) -> UIFont {
        let weight: UIFont.Weight = self.weight >= 600 ? .semibold : .regular
        return .systemFont(ofSize: pointSize(at: traits.preferredContentSizeCategory), weight: weight)
    }
}

/// The system's point size for each text style and size category, read once from UIKit: roles
/// ask for it on every redraw of every row.
@MainActor private enum AceRoleSizes {
    private struct Key: Hashable { let style: UIFont.TextStyle; let category: UIContentSizeCategory }
    private static var sizes: [Key: CGFloat] = [:]

    static func pointSize(_ style: UIFont.TextStyle, _ category: UIContentSizeCategory) -> CGFloat {
        // An unspecified category (a trait collection with none set) reads as the default size.
        let category = category == .unspecified ? .large : category
        let key = Key(style: style, category: category)
        if let size = sizes[key] { return size }
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let size = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits).pointSize
        sizes[key] = size
        return size
    }
}

/// Draws text in a role at the system's size for the current Dynamic Type size, times the
/// transcript's own scale where Settings › Appearance sets one.
@MainActor private struct AceRoleFont: ViewModifier {
    let role: AceDesign.Role
    let design: Font.Design
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.transcriptScale) private var scale

    func body(content: Content) -> some View {
        let category = UIContentSizeCategory(dynamicType)
        let size = role.pointSize(at: category) * scale
        let line = role.lineHeight(at: category) * scale
        return content.font(.system(size: size, weight: AceTheme.fontWeight(role.weight), design: design))
            .lineSpacing(max(AceTheme.Spacing.none, line - UIFont.systemFont(ofSize: size).lineHeight))
    }
}

extension View {
    /// Text in `role`, at the system's size for its text style at the current Dynamic Type size.
    @MainActor func aceFont(_ role: AceDesign.Role) -> some View {
        modifier(AceRoleFont(role: role, design: .default))
    }
    /// Code, commands, paths and branches in `role`, in mono.
    @MainActor func aceMonospace(_ role: AceDesign.Role) -> some View {
        modifier(AceRoleFont(role: role, design: .monospaced))
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
