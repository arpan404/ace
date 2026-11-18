import SwiftUI

/// One coding-agent CLI on a machine's page: its mark, name and status on the first line, what
/// it says about sign-in and its version under that, then each usage window as its own line:
/// the window on the left with when it resets under it, what is left on the right in a column of
/// its own, so the figures line up and read at a glance instead of as a table in tiny type.
struct ProviderRow: View {
    let provider: MachineProvidersInfo.Provider
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var markSize = AceDesign.Size.icon

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.groupGlyphGap) {
            if !stacked {
                ProviderMark(provider: provider.provider, size: AceDesign.Size.icon)
                    .frame(width: markSize).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                heading
                if !provider.usage.isEmpty { usage }
            }
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("provider.\(provider.provider)")
    }

    private var stacked: Bool { typeSize.isAccessibilitySize }

    private var heading: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            let line = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                               : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AceDesign.Space.related))
            line {
                Text(provider.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                if !stacked { Spacer(minLength: AceDesign.Space.related) }
                StateLabel(status: provider.status)
            }
            // The status word already says "Sign in needed"; the line adds only what's new.
            let summary = provider.summary.caseInsensitiveCompare(provider.status.label) == .orderedSame ? nil : provider.summary
            let detail = [summary, provider.version].compactMap { $0 }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var usage: some View {
        Grid(alignment: .leading, horizontalSpacing: AceDesign.Space.related, verticalSpacing: AceDesign.Space.tight) {
            ForEach(provider.usage, id: \.self) { window in
                if stacked {
                    GridRow { windowWords(window, left: true) }
                } else {
                    GridRow {
                        windowWords(window, left: false)
                        Text(window.left).aceFont(AceDesign.TextRole.meta).fontWeight(AceDesign.Typeface.strong)
                            .monospacedDigit().foregroundStyle(AceDesign.Ink.primary)
                            .gridColumnAlignment(.trailing)
                    }
                }
            }
        }
        .padding(.top, AceTheme.Spacing.xxs)
    }

    /// "Personal · Weekly" over "Resets in 3d 23h"; at accessibility sizes what is left joins them.
    private func windowWords(_ window: MachineProvidersInfo.Usage, left: Bool) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(window.label).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            let under = [left ? window.left : nil, window.resets].compactMap { $0 }.joined(separator: " · ")
            if !under.isEmpty {
                Text(under).aceFont(AceDesign.TextRole.time).monospacedDigit().foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
