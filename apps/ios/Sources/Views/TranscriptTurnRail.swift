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
    let jump: (Int) -> Void
    @State private var page: TurnsPage?
    @State private var scrub: Int?
    /// The finger on the edge band, while it is there.
    @State private var touch: TurnRail.BandTouch?
    @State private var selection = TurnRail.Selection()
    private var count: Int { page?.turns.first?.ordinal ?? 0 }
    private var current: Int { selection.current(scrub: scrub, place: reading.place, count: count) }

    var body: some View {
        GeometryReader { box in
            // Below the header and above the composer, which floats over the feed's foot.
            let height = max(box.size.height - bottom - AceDesign.Space.group * 2, 0)
            let ticks = TurnRail.ordinals(count: count, current: current, limit: TurnRail.limit(height: Double(height)))
            if TurnRail.shows(turns: count, behind: behind, keyboardUp: reading.keyboardUp, scrubbing: scrub != nil), height > AceDesign.Size.tap * 2 {
                rail(ticks: ticks, height: height)
                    .padding(.top, AceDesign.Space.group)
                    .frame(maxWidth: .infinity, alignment: .topTrailing)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: behind)
        .onChange(of: reading.place) { _, _ in selection.readerMoved() }
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: scrub) { _, new in new != nil }
        .task(id: behind) {
            guard behind else { selection.readerMoved(); return }
            page = try? await model.service(["type": "native.turns", "threadId": threadId], as: TurnsPage.self)
        }
    }

    /// The touch band at the screen's edge: no wider than the transcript's side margin, so it never
    /// covers a row, and swipes anywhere else along the rail still scroll the transcript.
    static let band = AceDesign.Space.feedSide

    private func rail(ticks: [Int], height: CGFloat) -> some View {
        // A full tap wide for VoiceOver and to draw in, but it takes no touches: only the band at
        // its trailing edge does (`band`), so the transcript under the rest of it still scrolls.
        Color.clear
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
            .allowsHitTesting(false)
            .overlay(alignment: .trailing) { touchBand(ticks: ticks, height: height) }
        .accessibilityElement()
        .accessibilityLabel("Turns")
        .accessibilityValue("Turn \(current) of \(count)")
        .accessibilityHint("Swipe up or down to pick a turn, then double-tap to go to it")
        .accessibilityAdjustableAction { direction in
            let step = direction == .increment ? 1 : direction == .decrement ? -1 : 0
            selection.pick(min(max(current + step, 1), count))
        }
        .accessibilityAction { jump(current) }
        .accessibilityIdentifier("transcript.turnRail")
    }

    /// One drag gesture that decides what the touch is (`TurnRail.BandTouch`): a tap jumps to the
    /// tick under it, a held touch then drag scrubs and lifting jumps, a quick swipe does nothing.
    private func touchBand(ticks: [Int], height: CGFloat) -> some View {
        let turn = { (y: Double) in TurnRail.tick(at: y, height: Double(height), ticks: ticks) }
        return Color.clear
            .frame(width: Self.band, height: height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        var now = touch ?? TurnRail.BandTouch(start: drag.time, y: Double(drag.startLocation.y))
                        now.moved(to: Double(drag.location.y), at: drag.time)
                        if now != touch { touch = now }
                        let under = now.scrubbing ? turn(Double(drag.location.y)) : nil
                        if under != scrub { scrub = under }
                    }
                    .onEnded { drag in
                        let lifted = touch?.lifted(at: Double(drag.location.y))
                        touch = nil
                        scrub = nil
                        guard let lifted, let picked = turn(lifted) else { return }
                        selection.pick(picked)
                        jump(picked)
                    }
            )
            .accessibilityHidden(true)
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

/// What the feed tells the rail: where the top of the transcript is as a scroll settles, and
/// whether the keyboard is up. Written only when a value changes, so the rail re-renders only then,
/// and read only by the rail, so the feed never re-renders for it.
@MainActor @Observable final class TurnRailPlace {
    private(set) var place: TurnRail.Place?
    private(set) var keyboardUp = false
    func settle(_ new: TurnRail.Place?) { if new != place { place = new } }
    func keyboard(up: Bool) { if up != keyboardUp { keyboardUp = up } }
}
