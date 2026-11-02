import SwiftUI

/// The one row anatomy the work log's rows share (the web's `transcript-row.tsx`): a 20pt lead
/// column, the title, an optional meta at the right; 44pt tall for touch, its lead lined up with
/// the prose above. A row that opens carries the disclosure caret after its title (DESIGN.md §4,
/// "Worked for 2m ›"), turned down while open; nil marks a row that opens nothing.
struct LogRowBox<Lead: View, Title: View, Meta: View>: View {
    var open: Bool? = nil
    @ViewBuilder var lead: () -> Lead
    @ViewBuilder var title: () -> Title
    @ViewBuilder var meta: () -> Meta
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            lead().foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(minWidth: AceDesign.Size.lead)
            HStack(spacing: AceDesign.Space.tight + AceTheme.Spacing.xxs) {
                title()
                if let open { DisclosureCaret(open: open) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            meta().aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground).monospacedDigit()
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .lineLimit(1)
        .frame(minHeight: AceDesign.Size.tap - AceDesign.Space.tight)
        .contentShape(Rectangle())
    }
}

/// The disclosure caret: faint, pointing right, turned down while its row is open.
struct DisclosureCaret: View {
    let open: Bool
    var body: some View {
        AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption2)
            .foregroundStyle(AceTheme.Colours.decoration)
            .rotationEffect(.degrees(open ? 90 : 0))
            .accessibilityHidden(true)
    }
}

extension LogRowBox where Meta == EmptyView {
    init(open: Bool? = nil, @ViewBuilder lead: @escaping () -> Lead, @ViewBuilder title: @escaping () -> Title) {
        self.init(open: open, lead: lead, title: title, meta: { EmptyView() })
    }
}

extension LogRowBox where Lead == EmptyView, Meta == EmptyView {
    /// A plain line with no lead: "Worked for 2m 5s".
    init(open: Bool? = nil, @ViewBuilder title: @escaping () -> Title) {
        self.init(open: open, lead: { EmptyView() }, title: title, meta: { EmptyView() })
    }
}

/// Where a row's details open: indented to the title, past the lead and the gap.
extension View {
    func rowDetailIndent() -> some View { padding(.leading, AceDesign.Size.lead + AceDesign.Space.related) }
}

/// Steps on a thin rail: an opened group, an opened "Worked for". Each finished step sits on the
/// rail with a small check, a failed one with a small cross, the step in flight with a quiet dot
/// (its words shimmer). Rows learn they are on a rail from the environment, so the same rows
/// draw in the plain flow and on the rail.
struct StepRail<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) { content() }
            .padding(.leading, Self.inset)
            .overlay(alignment: .leading) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                    .accessibilityHidden(true)
            }
            .padding(.leading, AceDesign.Space.related - AceTheme.Spacing.xxs)
            .environment(\.onRail, true)
            .transition(.opacity)
    }
    /// From the rail's line to the rows on it.
    static var inset: CGFloat { AceDesign.Space.margin + AceTheme.Spacing.xxs }
}

enum RailState { case done, running, failed }

extension View {
    /// The step's mark on the rail, when it is on one, level with its first line.
    func railMark(_ state: RailState) -> some View { modifier(RailMarkModifier(state: state)) }
}

private struct RailMarkModifier: ViewModifier {
    let state: RailState
    @Environment(\.onRail) private var onRail
    func body(content: Content) -> some View {
        if onRail {
            content.overlay(alignment: .topLeading) {
                mark.frame(width: AceDesign.Space.row, height: AceDesign.Space.row)
                    .background(AceTheme.Colours.background, in: Circle())
                    .offset(x: -StepRail<EmptyView>.inset - AceDesign.Space.row / 2,
                            y: (AceDesign.Size.tap - AceDesign.Space.tight - AceDesign.Space.row) / 2)
                    .accessibilityHidden(true)
            }
        } else {
            content
        }
    }
    @ViewBuilder private var mark: some View {
        switch state {
        case .done: AceIcon(.check, size: AceDesign.Size.glyphSmall, relativeTo: .caption2).foregroundStyle(AceTheme.Colours.subtleForeground)
        case .failed: AceIcon(.x, size: AceDesign.Size.glyphSmall, relativeTo: .caption2).foregroundStyle(AceTheme.StatusText.failed)
        case .running: Circle().fill(AceTheme.Colours.mutedForeground).frame(width: 6, height: 6)
        }
    }
}

extension EnvironmentValues {
    /// The row sits on a step rail: it shows its mark there.
    @Entry var onRail = false
}
