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

/// Where a strip's parts go, so its sentence keeps the row: a lone answer sits at the sentence's
/// end only when no pager shares the row; otherwise the pager and the answers take a line of
/// their own under the words.
enum DockLayout {
    static func inlineAction(actions: Int, paged: Bool) -> Bool { actions == 1 && !paged }
    /// Whether a strip opened in place folds again from a drag: down, and more down than across.
    static func collapses(dx: CGFloat, dy: CGFloat) -> Bool { dy > 30 && dy > abs(dx) }
}

/// Every strip above the composer, drawn alike: one glass shape the composer's width and corners,
/// sitting on it. One short sentence led by the provider's mark or the row's status icon; under it
/// at most one line, the payload in mono (cut in the middle, a tap shows it whole, or opens it) or
/// a muted detail. A tap on the strip, away from its buttons, opens it in place: the whole
/// sentence, detail and payload (a long detail scrolls inside); another tap or a drag down folds
/// it. Where the strip has more to show (a request's details), the open strip offers Details. Its
/// answers are real buttons at least 44 points tall with room between them: a lone one at
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
    /// Whether the strip is open in place, when its owner keeps it (a request strip, so paging
    /// keeps it open); nil keeps it in the strip's own state.
    var open: Binding<Bool>? = nil
    @State private var localOpen = false
    /// The detail's whole height, measured while folded too, so opening never jumps.
    @State private var detailHeight: CGFloat = 0
    private var expanded: Bool { open?.wrappedValue ?? localOpen }
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.inGlassBlock) private var inBlock
    @Environment(\.aceReduceMotion) private var reduceMotion

    private var paged: Bool { (pager?.total ?? 0) > 1 }
    private var inline: Bool { DockLayout.inlineAction(actions: actions.count, paged: paged) }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                StripLeadMark(lead: line.lead)
                sentence
                if inline, let only = actions.first { StripButton(action: only) }
            }
            if !line.payload.isEmpty { payload }
            if !line.detail.isEmpty { detail }
            if expanded, let openDetails {
                Button("Details", action: openDetails)
                    .buttonStyle(.plain)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(minHeight: AceDesign.Size.tap)
                    .padding(.leading, StripLeadMark.width + AceDesign.Space.related)
                    .accessibilityIdentifier(sentenceIdentifier)
            }
            if paged || !inline && !actions.isEmpty {
                HStack(spacing: AceDesign.Space.related) {
                    if let pager, paged { pagerView(pager) }
                    if !inline && !actions.isEmpty { StripButtons(actions: actions) } else { Spacer(minLength: 0) }
                }
                .padding(.top, AceDesign.Space.related)
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
        // A tap away from the buttons opens the strip in place, or folds it.
        .onTapGesture { toggle() }
        .gesture(swipe)
        .padding(.horizontal, inBlock ? AceTheme.Spacing.none : ReadingColumn.bar(sizeClass).composer)
        .padding(.bottom, inBlock ? AceTheme.Spacing.none : AceDesign.Space.tight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
        .accessibilityAction(named: expanded ? "Show less" : "Show more") { toggle() }
    }

    private func toggle() {
        withAnimation(reduceMotion ? nil : .default) {
            if let open { open.wrappedValue.toggle() } else { localOpen.toggle() }
        }
    }

    private var sentence: some View {
        Text(line.sentence)
            .aceFont(AceDesign.TextRole.segment).fontWeight(AceDesign.Typeface.regular)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(expanded ? nil : 2)
            .fixedSize(horizontal: false, vertical: true)
            .monospacedDigit()
            .contentTransition(.numericText())
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(openDetails == nil ? sentenceIdentifier : "strip.sentence")
    }

    /// The muted detail: two lines folded; open, all of it, scrolling inside past a few lines.
    @ViewBuilder private var detail: some View {
        let text = Text(line.detail)
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
        Group {
            if expanded {
                // Whole when it fits a few lines' room; past that it scrolls inside the strip.
                ScrollView { text.frame(maxWidth: .infinity, alignment: .leading) }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(detailHeight, AceDesign.Size.outputMaxHeight))
            } else {
                text.lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(alignment: .topLeading) {
            text.lineLimit(nil).fixedSize(horizontal: false, vertical: true).hidden()
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailHeight = $0 }
        }
        .padding(.leading, StripLeadMark.width + AceDesign.Space.related)
        .accessibilityIdentifier("strip.detail")
    }

    private var payload: some View {
        Button {
            if let openPayload, openDetails == nil { openPayload() } else { toggle() }
        } label: {
            Text(line.payload)
                .aceMonospace(AceDesign.TextRole.code)
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

    private func pagerView(_ pager: DockPager) -> some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button { pager.move(-1) } label: { pagerGlyph(.caretLeft) }
                .disabled(pager.index == 0)
                .accessibilityLabel("Previous request")
            Text("\(pager.index + 1) of \(pager.total)")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                .accessibilityIdentifier("strip.pager")
            Button { pager.move(1) } label: { pagerGlyph(.caretRight) }
                .disabled(pager.index >= pager.total - 1)
                .accessibilityLabel("Next request")
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .fixedSize()
    }

    /// A pager arrow: a caption glyph in a full tap.
    private func pagerGlyph(_ icon: AceIcon.Name) -> some View {
        AceIcon(icon, size: AceDesign.Size.glyphSmall, weight: .bold, relativeTo: .caption2)
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .contentShape(Rectangle())
    }

    /// A sideways swipe moves between the open requests; a drag down folds an open strip.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24).onEnded { drag in
            let dx = drag.translation.width, dy = drag.translation.height
            if expanded, DockLayout.collapses(dx: dx, dy: dy) { toggle(); return }
            guard let pager, abs(dx) > abs(dy), abs(dx) > 40 else { return }
            pager.move(dx < 0 ? 1 : -1)
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
                RowStatusIcon(kind: icon, tone: lead.tone ?? "idle", size: AceDesign.Size.rowStatus)
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

/// A strip's answer drawn as a button; request cards (`CardButton`) and Spade's approval share it,
/// so the same decision looks the same wherever it is asked.
struct StripButtonLook: ViewModifier {
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
