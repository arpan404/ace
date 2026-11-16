import SwiftUI

/// One of a strip's answers, drawn as a real button (owner, 2026-11-16): the primary one, the way
/// on ("Allow once", "Try again"), prominent glass; the rest bordered capsules in ink. Deny reads
/// as plainly as the others, never red.
struct DockAction: Identifiable {
    let id: String
    let label: String
    var primary = false
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

/// Every strip above the composer, drawn alike: one glass shape the composer's width and corners,
/// sitting on it. One short sentence led by the provider's mark or the row's status icon; under it
/// at most one line, the payload in mono (cut in the middle, a tap shows it whole, or opens it) or
/// a muted detail. Where the strip has more to show (a request's details), tapping its words opens
/// it. Its answers are real buttons at least 44 points tall with room between them: a lone one at
/// the sentence's end, several on a line of their own at the trailing edge, stacked full width
/// when they don't fit one line. Long content is never here: it opens in a sheet. The words come
/// from `@ace/ui-core/mobile`.
struct DockStrip: View {
    let line: StripLineRow
    var pager: DockPager? = nil
    let actions: [DockAction]
    /// Opens the payload in full; nil shows it whole in place on a tap.
    var openPayload: (() -> Void)? = nil
    /// Opens what the strip is about in full (a request's details): its sentence and payload are
    /// one tap that opens it.
    var openDetails: (() -> Void)? = nil
    var identifier = "thread.strip"
    var sentenceIdentifier = "strip.sentence"
    @State private var expanded = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.inGlassBlock) private var inBlock

    /// A lone answer fits at the sentence's end; more go on their own line.
    private var inline: Bool { actions.count == 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                StripLeadMark(lead: line.lead)
                sentence
                if let pager, pager.total > 1 { pagerView(pager) }
                if inline, let only = actions.first { StripButton(action: only) }
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
            if actions.count > 1 {
                StripButtons(actions: actions).padding(.top, AceDesign.Space.related)
            }
        }
        // Above the composer its words start where the field's do (`ReadingColumn.stripLead`).
        .padding(.leading, inBlock ? AceDesign.Space.margin : ReadingColumn.stripLead)
        .padding(.trailing, AceDesign.Space.margin)
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

    @ViewBuilder private var sentence: some View {
        if let openDetails {
            Button(action: openDetails) { sentenceText }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the details")
                .accessibilityIdentifier(sentenceIdentifier)
        } else {
            sentenceText.accessibilityIdentifier(sentenceIdentifier)
        }
    }

    private var sentenceText: some View {
        Text(line.sentence)
            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(2)
            .monospacedDigit()
            .contentTransition(.numericText())
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }

    private var payload: some View {
        Button {
            if let open = openDetails ?? openPayload { open() } else { withAnimation { expanded.toggle() } }
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
        .accessibilityHint(openDetails != nil ? "Shows the details" : expanded ? "Shows one line" : "Shows it all")
        .accessibilityIdentifier("strip.payload")
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

/// A strip's answers on their own line: in one row at the trailing edge when they fit, else
/// stacked full width, the way on last, nearest the thumb.
private struct StripButtons: View {
    let actions: [DockAction]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: AceDesign.Space.related) {
                ForEach(actions) { StripButton(action: $0) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            VStack(spacing: AceDesign.Space.related) {
                ForEach(actions) { StripButton(action: $0, fill: true) }
            }
        }
    }
}

/// One answer as a system capsule button: large, so it stands at least 44 points tall. The way on
/// is prominent glass on iOS 26 (filled before it); the rest are bordered in ink.
private struct StripButton: View {
    let action: DockAction
    var fill = false
    var body: some View {
        Button(action: action.run) {
            Text(action.label)
                .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                .fontWeight(action.primary ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                .lineLimit(1)
                .frame(maxWidth: fill ? .infinity : nil)
        }
        .modifier(StripButtonLook(primary: action.primary))
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .frame(minHeight: AceDesign.Size.tap)
        .fixedSize(horizontal: !fill, vertical: false)
        .disabled(!action.enabled)
        .accessibilityIdentifier(action.identifier ?? "strip.\(action.id)")
    }
}

private struct StripButtonLook: ViewModifier {
    let primary: Bool
    func body(content: Content) -> some View {
        if primary {
            if #available(iOS 26, *) {
                content.buttonStyle(.glassProminent).tint(AceTheme.Colours.accent)
            } else {
                content.buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
            }
        } else {
            content.buttonStyle(.bordered).tint(AceTheme.Colours.foreground)
        }
    }
}
