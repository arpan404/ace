import SwiftUI

/// A cardless group on a page or a sheet (design language §2 "No boxes in boxes"): a quiet
/// heading in the meta role, then its rows split by hairlines that start at the margin. No fill,
/// no border, no rounded box: hierarchy comes from type and space. Groups stack 24 apart.
struct QuietSection<Content: View>: View {
    let title: String?
    @ViewBuilder let content: () -> Content
    init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let title {
                Text(title).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.tight)
                    .accessibilityAddTraits(.isHeader)
            }
            Group(subviews: content()) { rows in
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Hairline().padding(.leading, AceDesign.Space.margin) }
                    row
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row of a quiet section: the margin at both sides and the one-line row's height.
struct QuietSectionRow<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(spacing: AceDesign.Space.related) { content() }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.tight)
            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine, alignment: .leading)
            .contentShape(Rectangle())
    }
}

/// A row's two lines: its title in the row role over an optional muted line.
struct QuietRowText: View {
    let title: String
    var detail: String? = nil
    var mono = false
    var tone: Color = AceDesign.Ink.primary
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Group {
                if mono { Text(verbatim: title).aceMonospace(AceDesign.TextRole.rowTitle, relativeTo: .callout) }
                else { Text(title).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout) }
            }
            .foregroundStyle(tone).lineLimit(1).truncationMode(.middle)
            if let detail, !detail.isEmpty {
                Text(detail).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A word that acts ("Move here", "Link a pull request", "Retry"): the action role, no icon, no
/// fill at rest, 44pt taps. `prominent` is the one ink-and-semibold way forward; `plain` reads
/// muted; `destructive` is the failed colour, kept for actions that lose something.
struct TextActionStyle: ButtonStyle {
    enum Tone { case prominent, plain, destructive }
    var tone: Tone = .plain
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
            .fontWeight(tone == .prominent ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(colour(pressed: configuration.isPressed))
            .lineLimit(1)
            .frame(minHeight: AceDesign.Size.stripAction)
            .tapBand(drawn: AceDesign.Size.stripAction)
            .opacity(enabled ? configuration.isPressed ? AceDesign.Ink.pressed : 1 : AceTheme.Opacity.disabled(scheme))
            .contentShape(Rectangle())
    }
    private func colour(pressed: Bool) -> Color {
        switch tone {
        case .prominent: AceDesign.Ink.primary
        case .plain: AceDesign.Ink.muted
        case .destructive: AceTheme.StatusText.failed
        }
    }
}

extension ButtonStyle where Self == TextActionStyle {
    static func textAction(_ tone: TextActionStyle.Tone = .plain) -> TextActionStyle { TextActionStyle(tone: tone) }
}

/// The faint caret at the end of a row that opens a page.
struct RowCaret: View {
    var body: some View {
        AceIcon(.caretRight, size: AceDesign.Size.chevron, weight: .bold, relativeTo: .caption)
            .foregroundStyle(AceDesign.Ink.faint)
            .accessibilityHidden(true)
    }
}
