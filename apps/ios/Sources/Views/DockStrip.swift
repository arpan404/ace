import SwiftUI

/// One of a strip's actions: a word, the primary one in semibold ink, the rest muted. Never an
/// icon, a capsule or a colour: Deny reads as plainly as the others.
struct DockAction: Identifiable {
    let id: String
    let label: String
    var primary = false
    var enabled = true
    /// The accessibility identifier; `strip.<id>` when not given.
    var identifier: String? = nil
    /// A way to more (Details): first, apart from the answers.
    var aside = false
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
/// a tap shows it whole, or opens it) or a muted detail. Its actions are words, "Deny · Always ·
/// Allow": at the sentence's end when they fit beside it, else on a line of their own at the
/// trailing edge. Long content is never here: it opens in a sheet. The words come from
/// `@ace/ui-core/mobile`.
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
    @Environment(\.inGlassBlock) private var inBlock

    /// Details first, then the answers in the bridge's order.
    private var ordered: [DockAction] { actions.filter(\.aside) + actions.filter { !$0.aside } }
    /// The words fit at the sentence's end: at most two short ones beside it.
    private var inline: Bool { actions.count <= 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                StripLeadMark(lead: line.lead)
                sentence
                if let pager, pager.total > 1 { pagerView(pager) }
                if inline { words(ordered) }
            }
            if !line.payload.isEmpty { payload }
            if !line.detail.isEmpty {
                Text(line.detail)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(2)
                    .padding(.leading, StripLeadMark.width + AceDesign.Space.related)
                    .accessibilityIdentifier("strip.detail")
            }
            if !inline {
                words(ordered).frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, AceDesign.Space.tight)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.stripBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Its own glass, the only glass above the composer capsule (and on a subagent's view).
        .modifier(StripSurfaceGlass(inBlock: inBlock))
        .contentShape(Rectangle())
        .gesture(swipe)
        .padding(.horizontal, inBlock ? AceTheme.Spacing.none : ReadingColumn.bar(sizeClass).composer)
        .padding(.bottom, inBlock ? AceTheme.Spacing.none : AceDesign.Space.tight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var sentence: some View {
        Text(line.sentence)
            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(2)
            .monospacedDigit()
            .contentTransition(.numericText())
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(sentenceIdentifier)
    }

    private var payload: some View {
        Button {
            if let openPayload { openPayload() } else { withAnimation(AceDesign.Motion.arriving(reduceMotion)) { expanded.toggle() } }
        } label: {
            Text(line.payload)
                .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(expanded ? nil : 1)
                .truncationMode(.middle)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, StripLeadMark.width + AceDesign.Space.related)
        .accessibilityLabel(line.payload)
        .accessibilityHint(expanded ? "Shows one line" : "Shows it all")
        .accessibilityIdentifier("strip.payload")
    }

    private func words(_ shown: [DockAction]) -> some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(shown) { action in
                Button(action.label, action: action.run)
                    .buttonStyle(StripTextButtonStyle(prominent: action.primary))
                    .disabled(!action.enabled)
                    .accessibilityIdentifier(action.identifier ?? "strip.\(action.id)")
            }
        }
        .fixedSize()
    }

    private func pagerView(_ pager: DockPager) -> some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button { pager.move(-1) } label: { pagerGlyph("chevron.left") }
                .disabled(pager.index == 0)
                .accessibilityLabel("Previous request")
            Text("\(pager.index + 1) of \(pager.total)")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                .accessibilityIdentifier("strip.pager")
            Button { pager.move(1) } label: { pagerGlyph("chevron.right") }
                .disabled(pager.index >= pager.total - 1)
                .accessibilityLabel("Next request")
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .fixedSize()
    }

    /// A pager arrow: a caption glyph in a full tap.
    private func pagerGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol).font(AceDesign.Typeface.caption.weight(AceDesign.Typeface.strong))
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .contentShape(Rectangle())
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
    static let width = AceDesign.Size.rowStatus
    var body: some View {
        Group {
            if let provider = lead.provider, !provider.isEmpty {
                ProviderMark(provider: provider, size: AceDesign.Size.rowMark)
            } else if let icon = lead.icon {
                RowStatusIcon(kind: icon, tone: lead.tone ?? "idle", size: AceDesign.Size.rowStatusSymbol)
            }
        }
        .frame(width: Self.width)
        .accessibilityHidden(true)
    }
}

/// A strip's own glass when it stands alone; inside the block it draws nothing of its own.
private struct StripSurfaceGlass: ViewModifier {
    let inBlock: Bool
    func body(content: Content) -> some View {
        if inBlock { content } else { content.aceGlass(in: AceDesign.Shape.container) }
    }
}
