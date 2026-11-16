import SwiftUI

/// The turn rail over the transcript's trailing edge (`TurnRail`): one short tick per turn shown,
/// the reader's turn brighter. Touching and holding its edge band, then dragging, scrubs: a card
/// beside the finger names the turn and its ask, and lifting jumps there. A tap there jumps too;
/// a swipe anywhere else along it scrolls the transcript. VoiceOver adjusts the turn and
/// activates to jump. It reads the turn list once each time the reader leaves the end, never
/// while the feed scrolls, and sits over the feed rather than in its scroll view.
struct TranscriptTurnRail: View {
    let model: ClientModel
    let threadId: String
    /// The person reads away from the live end; leaving it reads the turn list.
    let behind: Bool
    /// Where the top of the screen is, when the feed knows it, and whether the keyboard is up
    /// (the rail steps aside without the reader having moved).
    let reading: TurnRailPlace
    /// Room below the rail: the composer, which floats over the feed's foot.
    let bottom: CGFloat
    @State private var page: TurnsPage?
    @State private var selection = TurnRail.Selection()
    private var count: Int { page?.turns.first?.ordinal ?? 0 }
    /// The reader's turn, or the one just picked; the finger's, while it scrubs, is marked over it.
    private var readerTurn: Int { selection.current(scrub: nil, place: reading.place, count: count) }

    var body: some View {
        GeometryReader { box in
            // Below the header and above the composer, which floats over the feed's foot.
            let height = max(box.size.height - bottom - AceDesign.Space.group * 2, 0)
            let ticks = TurnRail.ordinals(count: count, current: readerTurn, limit: TurnRail.limit(height: Double(height)))
            let scrub = reading.finger.flatMap { TurnRail.tick(at: Double($0), height: Double(height), ticks: ticks) }
            if TurnRail.shows(turns: count, behind: behind, keyboardUp: reading.keyboardUp, scrubbing: scrub != nil), height > AceDesign.Size.tap * 2 {
                rail(ticks: ticks, height: height, scrub: scrub)
                    .padding(.top, AceDesign.Space.group)
                    .frame(maxWidth: .infinity, alignment: .topTrailing)
                    .transition(.opacity)
                    .sensoryFeedback(AceDesign.Haptic.tab, trigger: scrub) { _, new in new != nil }
                    // A lift or tap on the band (`TurnRailBand`) jumps to the tick under it.
                    .onChange(of: reading.lift) { _, lift in
                        guard let lift, let picked = TurnRail.tick(at: Double(lift.y), height: Double(height), ticks: ticks) else { return }
                        selection.pick(picked)
                        reading.ask(turn: picked, count: count)
                    }
            }
        }
        .animation(.default, value: behind)
        .onChange(of: reading.place) { _, _ in selection.readerMoved() }
        .task(id: behind) {
            guard behind else { selection.readerMoved(); return }
            page = try? await model.service(["type": "native.turns", "threadId": threadId], as: TurnsPage.self)
        }
    }

    /// The touch band at the screen's edge: no wider than the transcript's side margin, so it never
    /// covers a row. It takes no touches itself; the recognizers on the feed take those that
    /// start on it (`TurnRailBand`), so a swipe that doesn't hold first still scrolls.
    static let band = ReadingColumn.bar(.compact).text

    private func rail(ticks: [Int], height: CGFloat, scrub: Int?) -> some View {
        let current = scrub ?? readerTurn
        // A full tap wide for VoiceOver and to draw in; touches pass through to the transcript.
        return Color.clear
            .frame(width: AceDesign.Size.tap, height: height)
            .overlay(alignment: .topTrailing) {
                ZStack(alignment: .topTrailing) {
                    ForEach(ticks, id: \.self) { ordinal in
                        let lit = ordinal == current
                        Capsule()
                            .fill(lit ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                            .frame(width: lit ? AceDesign.Space.group : AceDesign.Space.related, height: AceTheme.Dimensions.border * 2)
                            .offset(y: TurnRail.offset(of: ordinal, height: Double(height), ticks: ticks).map { CGFloat($0) } ?? 0)
                    }
                    if let scrub, let y = TurnRail.offset(of: scrub, height: Double(height), ticks: ticks) {
                        card(scrub)
                            .offset(x: -AceDesign.Size.tap, y: CGFloat(y) - AceDesign.Size.tap / 2)
                    }
                }
                .padding(.trailing, AceDesign.Space.tight)
                .accessibilityHidden(true)
            }
            .overlay(alignment: .trailing) {
                // Where the band is in the window, for the recognizers on the feed; only on a change.
                Color.clear.frame(width: Self.band, height: height)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { reading.band = $0 }
                    .onDisappear { reading.band = nil }
                    .accessibilityHidden(true)
            }
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel("Turns")
            .accessibilityValue("Turn \(current) of \(count)")
            .accessibilityHint("Swipe up or down to pick a turn, then double-tap to go to it")
            .accessibilityAdjustableAction { direction in
                let step = direction == .increment ? 1 : direction == .decrement ? -1 : 0
                selection.pick(min(max(current + step, 1), count))
            }
            .accessibilityAction { reading.ask(turn: current, count: count) }
            .accessibilityIdentifier("transcript.turnRail")
    }

    /// The turn under the finger: its number, and its ask when the newest page holds it.
    private func card(_ ordinal: Int) -> some View {
        let ask = page?.turns.first { $0.ordinal == ordinal }?.ask
        return VStack(alignment: .trailing, spacing: AceTheme.Spacing.xxs) {
            Text("Turn \(ordinal) of \(count)").monospacedDigit()
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            if let ask {
                Text(ask.isEmpty ? "No text in this ask" : ask).lineLimit(2)
                    .foregroundStyle(AceTheme.Colours.foreground)
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .padding(.horizontal, AceDesign.Space.related).padding(.vertical, AceDesign.Space.tight)
        .frame(maxWidth: AceDesign.Size.tap * 5, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
        .aceGlass(in: AceShape.capsule)
    }
}

/// The rail over the feed, not in it, so it shares neither the transcript's scroll view nor its
/// layout; its band takes touches through recognizers on the feed (`TurnRailBand`), so swipes
/// still scroll. The feed brings a picked turn into view (`TurnRailPlace`).
struct TurnRailOverlay: ViewModifier {
    let model: ClientModel
    let threadId: String
    let behind: Bool
    let place: TurnRailPlace
    let bottom: CGFloat
    func body(content: Content) -> some View {
        content
            .overlay { TranscriptTurnRail(model: model, threadId: threadId, behind: behind, reading: place, bottom: bottom) }
            .gesture(TurnRailBand.Hold(place: place))
            .gesture(TurnRailBand.Tap(place: place))
    }
}

/// What the feed and the rail tell each other: where the top of the transcript is as a scroll
/// settles and whether the keyboard is up, which only the rail reads and which is written only
/// when it changes; and the turn picked on the rail, which only the feed reads.
@MainActor @Observable final class TurnRailPlace {
    private(set) var place: TurnRail.Place?
    private(set) var keyboardUp = false
    /// The turn last picked on the rail, which the feed brings into view.
    private(set) var request: TurnRail.JumpRequest?
    /// The finger scrubbing the band, from the band's top; nil when none is.
    private(set) var finger: CGFloat?
    /// The finger last lifted (or tapped) on the band, from its top; `id` tells two lifts apart.
    private(set) var lift: Lift?
    struct Lift: Equatable { let id: Int; let y: CGFloat }
    /// The band's frame in the window while it is on screen, for the recognizers on the feed
    /// (`TurnRailBand`). Not observed: it never re-renders anything.
    @ObservationIgnored var band: CGRect?
    /// Each scrub that began: the reader took the feed, so a focus still landing lets go. Only
    /// the feed reads it.
    private(set) var takeovers = 0
    func fingerMoved(to y: CGFloat) {
        if finger == nil { takeovers += 1 }
        if y != finger { finger = y }
    }
    func fingerLifted(at y: CGFloat?) {
        finger = nil
        if let y { lift = Lift(id: (lift?.id ?? 0) + 1, y: y) }
    }
    func ask(turn: Int, count: Int) { request = TurnRail.JumpRequest(id: (request?.id ?? 0) + 1, turn: turn, count: count) }
    func settle(_ new: TurnRail.Place?) { if new != place { place = new } }
    func keyboard(up: Bool) { if up != keyboardUp { keyboardUp = up } }
}
