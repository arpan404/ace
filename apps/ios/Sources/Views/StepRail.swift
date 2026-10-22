import SwiftUI

/// The one row anatomy the work log's rows share (the web's `transcript-row.tsx`): a 20pt lead
/// column, the title, an optional meta at the right; 44pt tall for touch. Its wash bleeds 8pt
/// past the reading column, so the lead lines up with the prose above. A row that opens shows
/// its open state as a soft wash, never a caret.
struct LogRowBox<Lead: View, Title: View, Meta: View>: View {
    var open = false
    @ViewBuilder var lead: () -> Lead
    @ViewBuilder var title: () -> Title
    @ViewBuilder var meta: () -> Meta
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            lead().foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(minWidth: AceTheme.Spacing.xl)
            title().frame(maxWidth: .infinity, alignment: .leading)
            meta().aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground).monospacedDigit()
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .lineLimit(1)
        .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
        .padding(.horizontal, AceTheme.Spacing.sm)
        .background(open ? AceTheme.Colours.fill : .clear, in: RoundedRectangle(cornerRadius: AceTheme.Radii.md, style: .continuous))
        .contentShape(Rectangle())
        .padding(.horizontal, -AceTheme.Spacing.sm)
    }
}

extension LogRowBox where Meta == EmptyView {
    init(open: Bool = false, @ViewBuilder lead: @escaping () -> Lead, @ViewBuilder title: @escaping () -> Title) {
        self.init(open: open, lead: lead, title: title, meta: { EmptyView() })
    }
}

extension LogRowBox where Lead == EmptyView, Meta == EmptyView {
    /// A plain line with no lead: "Worked for 2m 5s".
    init(open: Bool = false, @ViewBuilder title: @escaping () -> Title) {
        self.init(open: open, lead: { EmptyView() }, title: title, meta: { EmptyView() })
    }
}

/// Where a row's details open: indented to the title, past the lead and the gap.
extension View {
    func rowDetailIndent() -> some View { padding(.leading, AceTheme.Spacing.xl + AceTheme.Spacing.sm) }
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
            .padding(.leading, AceTheme.Spacing.sm - AceTheme.Spacing.xxs)
            .environment(\.onRail, true)
            .transition(.opacity)
    }
    /// From the rail's line to the rows on it.
    static var inset: CGFloat { AceTheme.Spacing.lg + AceTheme.Spacing.xxs }
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
                mark.frame(width: AceTheme.Spacing.md, height: AceTheme.Spacing.md)
                    .background(AceTheme.Colours.background, in: Circle())
                    .offset(x: -StepRail<EmptyView>.inset - AceTheme.Spacing.md / 2,
                            y: (AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs - AceTheme.Spacing.md) / 2)
                    .accessibilityHidden(true)
            }
        } else {
            content
        }
    }
    @ViewBuilder private var mark: some View {
        switch state {
        case .done: AceIcon(.check, size: 10, weight: .bold, relativeTo: .caption2).foregroundStyle(AceTheme.Colours.subtleForeground)
        case .failed: AceIcon(.x, size: 10, weight: .bold, relativeTo: .caption2).foregroundStyle(AceTheme.StatusText.failed)
        case .running: Circle().fill(AceTheme.Colours.mutedForeground).frame(width: 6, height: 6)
        }
    }
}

extension EnvironmentValues {
    /// The row sits on a step rail: it shows its mark there.
    @Entry var onRail = false
}
