import SwiftUI

/// One of a strip's actions: a word, the primary one filled. Never an icon.
struct DockAction: Identifiable {
    let id: String
    let label: String
    var primary = false
    var destructive = false
    var enabled = true
    /// The accessibility identifier; `strip.<id>` when not given.
    var identifier: String? = nil
    let run: () -> Void
}

/// "1 of 3" with ‹ › between the open requests; the strip swipes between them too.
struct DockPager {
    let index: Int
    let total: Int
    let move: (Int) -> Void
}

/// Every strip above the composer, drawn alike (DESIGN.md "words, not chrome"): one glass shape
/// the composer's width and corners, sitting on it. One short sentence led by the provider's mark
/// or the row's status icon; under it at most one line, the payload in mono (cut in the middle,
/// a tap shows it whole, or opens it) or a muted detail. One or two actions are words at the
/// sentence's end; three or more are capsules on a row of their own, the primary filled. Long
/// content is never here: it opens in a sheet. The words come from `@ace/ui-core/mobile`.
struct DockStrip: View {
    let line: StripLineRow
    var pager: DockPager? = nil
    let actions: [DockAction]
    /// Opens the payload in full; nil shows it whole in place on a tap.
    var openPayload: (() -> Void)? = nil
    var identifier = "thread.strip"
    var sentenceIdentifier = "strip.sentence"
    @State private var expanded = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.aceReduceMotion) private var reduceMotion

    private var inline: Bool { actions.count < 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(alignment: .center, spacing: AceTheme.Spacing.sm) {
                StripLeadMark(lead: line.lead)
                Text(line.sentence)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.medium)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(2)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(sentenceIdentifier)
                if let pager, pager.total > 1 { pagerView(pager) }
                if inline { words }
            }
            if !line.payload.isEmpty { payload }
            if !line.detail.isEmpty {
                Text(line.detail)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(2)
                    .padding(.leading, StripLeadMark.width + AceTheme.Spacing.sm)
                    .accessibilityIdentifier("strip.detail")
            }
            if !inline { capsules }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .aceGlass(in: AceShape.field)
        .contentShape(AceShape.field)
        .gesture(swipe)
        .padding(.horizontal, ReadingColumn.bar(sizeClass).composer)
        .padding(.bottom, AceTheme.Spacing.xs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var payload: some View {
        Button {
            if let openPayload { openPayload() } else { withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) { expanded.toggle() } }
        } label: {
            Text(line.payload)
                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(expanded ? nil : 1)
                .truncationMode(.middle)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, StripLeadMark.width + AceTheme.Spacing.sm)
        .accessibilityLabel(line.payload)
        .accessibilityHint(expanded ? "Shows one line" : "Shows it all")
        .accessibilityIdentifier("strip.payload")
    }

    private var words: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(actions) { action in
                Button(action.label, action: action.run)
                    .buttonStyle(StripTextButtonStyle(prominent: action.primary))
                    .disabled(!action.enabled)
                    .accessibilityIdentifier(action.identifier ?? "strip.\(action.id)")
            }
        }
        .fixedSize()
    }

    private var capsules: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            ForEach(actions) { action in
                Button(action.label, action: action.run)
                    .buttonStyle(DockCapsuleStyle(primary: action.primary, destructive: action.destructive))
                    .disabled(!action.enabled)
                    .accessibilityIdentifier(action.identifier ?? "strip.\(action.id)")
            }
        }
    }

    private func pagerView(_ pager: DockPager) -> some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button { pager.move(-1) } label: { Image(systemName: "chevron.left").font(.caption.weight(.semibold)) }
                .disabled(pager.index == 0)
                .accessibilityLabel("Previous request")
            Text("\(pager.index + 1) of \(pager.total)")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                .accessibilityIdentifier("strip.pager")
            Button { pager.move(1) } label: { Image(systemName: "chevron.right").font(.caption.weight(.semibold)) }
                .disabled(pager.index >= pager.total - 1)
                .accessibilityLabel("Next request")
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .fixedSize()
    }

    /// A sideways swipe moves between the open requests.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24).onEnded { drag in
            guard let pager, abs(drag.translation.width) > abs(drag.translation.height), abs(drag.translation.width) > 40 else { return }
            pager.move(drag.translation.width < 0 ? 1 : -1)
        }
    }
}

/// A strip's lead: the asking agent's provider mark in its colours, or the row's status icon in
/// its state's colour (`RowStatusIcon`).
struct StripLeadMark: View {
    let lead: StripLeadRow
    static let width: CGFloat = 18
    var body: some View {
        Group {
            if let provider = lead.provider, !provider.isEmpty {
                ProviderMark(provider: provider, size: 16)
            } else if let icon = lead.icon {
                RowStatusIcon(kind: icon, tone: lead.tone ?? "idle")
            }
        }
        .frame(width: Self.width)
        .accessibilityHidden(true)
    }
}

/// Three or more actions: capsules sharing a row, the primary one filled in ink.
struct DockCapsuleStyle: ButtonStyle {
    var primary = false
    var destructive = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .fontWeight(primary ? .semibold : .medium)
            .lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(primary ? AceTheme.Colours.background
                             : destructive ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
            .background(primary ? AceTheme.Colours.foreground : AceTheme.Colours.fill, in: AceShape.capsule)
            .opacity(configuration.isPressed ? 0.8 : enabled ? 1 : AceTheme.Opacity.disabled(scheme))
            .contentShape(AceShape.capsule)
    }
}
