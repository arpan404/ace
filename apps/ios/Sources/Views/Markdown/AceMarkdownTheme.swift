import Markit
import SwiftUI
import UIKit

/// ace's look for markit (DESIGN.md): SF Pro prose at the transcript size with its 23pt lines,
/// headings at the title and row-title sizes, SF Mono code at the code size on the code surface
/// with a hairline edge and 12pt corners, links in the accent, quotes, rules and table edges in
/// the separator, and the diff tints of the changes views.
///
/// markit restyles a view whenever its theme compares unequal, so one value is kept per look:
/// `standard` for the default palette at the default size, and the last few others (a saved
/// palette, Settings › Appearance's transcript size, a thought's muted ink) in a small cache.
@MainActor enum AceMarkdownTheme {
    /// What prose is drawn in: the foreground, or the muted ink of a thought.
    enum Tone: Equatable, Sendable { case body, muted }

    /// Everything a theme is made from, so equal looks share one theme value.
    private struct Look: Equatable {
        var palette: [String: NativePalette.Pair]
        var scale: CGFloat
        var tone: Tone
    }

    private static let roles = ["foreground", "mutedForeground", "subtleForeground", "separator", "fill", "accent"]

    private static let standardLook = Look(palette: Dictionary(uniqueKeysWithValues: roles.map { ($0, defaultPair($0)) }), scale: 1, tone: .body)
    /// The default palette at the default size.
    static let standard = theme(standardLook)
    private static var recent: [(look: Look, theme: MarkitTheme)] = []

    /// The theme for the palette on screen. Reading it from a view's body follows palette saves.
    static func current(scale: CGFloat = 1, tone: Tone = .body) -> MarkitTheme {
        let look = Look(palette: Dictionary(uniqueKeysWithValues: roles.map { ($0, livePair($0)) }), scale: scale, tone: tone)
        if look == standardLook { return standard }
        if let kept = recent.first(where: { $0.look == look }) { return kept.theme }
        let made = theme(look)
        recent = Array(([(look: look, theme: made)] + recent).prefix(6))
        return made
    }

    private static func defaultPair(_ role: String) -> NativePalette.Pair {
        AceTheme.tokenPairs[role] ?? NativePalette.Pair(light: 0x222222, dark: 0xDEDEDE)
    }
    private static func livePair(_ role: String) -> NativePalette.Pair {
        let fallback = defaultPair(role)
        return NativePaletteBridge.pair(for: role, light: fallback.light, dark: fallback.dark)
    }

    /// A theme from its look alone, so equal looks always draw alike.
    private static func theme(_ look: Look) -> MarkitTheme {
        let type = AceTheme.Typography.self
        let scale = look.scale
        func colour(_ role: String) -> UIColor { dynamic(look.palette[role] ?? defaultPair(role)) }

        var theme = MarkitTheme()
        let body = UIFont.systemFont(ofSize: type.body.size * scale)
        theme.bodyFont = .scaled(body, relativeTo: .body)
        theme.headingFonts = [type.title, type.title, type.rowTitle, type.rowTitle, type.rowTitle, type.rowTitle].map { style in
            MarkitFont.scaled(UIFont.systemFont(ofSize: style.size * scale, weight: weight(style.weight)), relativeTo: .headline)
        }
        theme.monospaceFont = .scaled(.monospacedSystemFont(ofSize: type.code.size * scale, weight: .regular), relativeTo: .footnote)
        theme.tableFont = .scaled(body, relativeTo: .body)
        theme.captionFont = .scaled(.systemFont(ofSize: type.caption.size, weight: .regular), relativeTo: .caption1)

        theme.textColor = colour(look.tone == .muted ? "mutedForeground" : "foreground")
        theme.secondaryTextColor = colour("mutedForeground")
        theme.linkColor = colour("accent")
        theme.inlineCodeBackground = colour("fill")
        theme.codeBlockBackground = colour("fill")
        theme.codeHeaderBackground = colour("fill")
        theme.codeBorder = colour("separator")
        theme.quoteBar = colour("separator")
        theme.tableBorder = colour("separator")
        theme.tableHeaderBackground = colour("fill")
        theme.ruleColor = colour("separator")
        // GitHub alerts stay monochrome, as ace drew them: colour means state (DESIGN.md), so the
        // kind reads from its title word, in the ink.
        let alert = colour("foreground")
        theme.alertNote = alert
        theme.alertTip = alert
        theme.alertImportant = alert
        theme.alertWarning = alert
        theme.alertCaution = alert
        theme.footnoteFont = .scaled(.systemFont(ofSize: type.caption.size * scale, weight: .regular), relativeTo: .footnote)
        theme.diffAddition = UIColor(AceTheme.Colours.diffAdd)
        theme.diffDeletion = UIColor(AceTheme.Colours.diffDelete)
        // markit's grammar colours, with plain code in the page's own ink.
        let ink = look.palette["foreground"] ?? defaultPair("foreground")
        let text = MarkitColorPair(light: rgb(ink.light), dark: rgb(ink.dark))
        var syntax = MarkitColorPair.defaultSyntaxPalette
        if !syntax.isEmpty { syntax[0] = text }
        theme.syntaxPalette = syntax
        theme.syntaxFallback = text

        // The transcript's 23pt lines over 16pt type, at the transcript's size.
        theme.lineSpacing = max(0, type.body.lineHeight * scale - body.lineHeight)
        theme.paragraphSpacing = AceTheme.Spacing.sm
        theme.blockSpacing = AceTheme.Spacing.sm
        theme.listIndent = AceTheme.Spacing.lg
        theme.quoteIndent = AceTheme.Spacing.md
        theme.quoteBarWidth = AceTheme.Spacing.xxs
        theme.codeInsets = UIEdgeInsets(top: AceTheme.Spacing.sm, left: AceTheme.Spacing.md, bottom: AceTheme.Spacing.md, right: AceTheme.Spacing.md)
        theme.codeCornerRadius = AceTheme.Radii.code
        theme.tableCellInsets = UIEdgeInsets(top: AceTheme.Spacing.sm, left: AceTheme.Spacing.sm, bottom: AceTheme.Spacing.sm, right: AceTheme.Spacing.sm)
        return theme
    }

    private static func weight(_ value: CGFloat) -> UIFont.Weight {
        switch value {
        case 500: .medium
        case 600: .semibold
        case 700: .bold
        default: .regular
        }
    }

    /// A palette pair as one colour that follows the appearance. UIKit resolves it on render
    /// threads too, so the provider touches only its captured values.
    private nonisolated static func dynamic(_ pair: NativePalette.Pair) -> UIColor {
        let light = pair.light, dark = pair.dark
        return UIColor { @Sendable traits in rgb(traits.userInterfaceStyle == .dark ? dark : light) }
    }

    private nonisolated static func rgb(_ value: UInt32) -> UIColor {
        UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }
}
