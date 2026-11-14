import SwiftUI

/// The turn rail on the transcript's trailing edge (`TurnRail`): one short tick per turn shown,
/// the reader's turn brighter. A finger on it scrubs, a card beside the finger names the turn and
/// its ask, and lifting jumps there. VoiceOver adjusts the turn and activates to jump. It reads
/// the turn list once each time the reader leaves the end, never while the feed scrolls.
struct TranscriptTurnRail: View {
    let model: ClientModel
    let threadId: String
    /// The person reads away from the live end; leaving it reads the turn list.
    let behind: Bool
    /// The keyboard is up: the rail steps aside without the reader having moved.
    let keyboardUp: Bool
    /// Where the top of the screen is, when the feed knows it.
    let reading: TurnRailPlace
    /// Room below the rail: the composer and the keyboard, which float over the feed's foot.
    let bottom: CGFloat
    let jump: (Int) -> Void
    @State private var page: TurnsPage?
    @State private var scrub: Int?
    @State private var selection = TurnRail.Selection()
    private var count: Int { page?.turns.first?.ordinal ?? 0 }
    private var current: Int { selection.current(scrub: scrub, place: reading.place, count: count) }

    var body: some View {
        GeometryReader { box in
            // Below the header and above the composer, which floats over the feed's foot.
            let height = max(box.size.height - bottom - AceDesign.Space.group * 2, 0)
            let ticks = TurnRail.ordinals(count: count, current: current, limit: TurnRail.limit(height: Double(height)))
            if TurnRail.shows(turns: count, behind: behind, keyboardUp: keyboardUp, scrubbing: scrub != nil), height > AceDesign.Size.tap * 2 {
                rail(ticks: ticks, height: height)
                    .padding(.top, AceDesign.Space.group)
                    .frame(maxWidth: .infinity, alignment: .topTrailing)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: behind)
        .animation(.default, value: keyboardUp)
        .onChange(of: reading.place) { _, _ in selection.readerMoved() }
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: scrub) { _, new in new != nil }
        .task(id: behind) {
            guard behind else { selection.readerMoved(); return }
            page = try? await model.service(["type": "native.turns", "threadId": threadId], as: TurnsPage.self)
        }
    }

    private func rail(ticks: [Int], height: CGFloat) -> some View {
        // The strip itself is the touch area, a full tap wide and the rail's height; the ticks and
        // the card are drawn over it, so a tap anywhere along it lands.
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
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { drag in scrub = TurnRail.tick(at: Double(drag.location.y), height: Double(height), ticks: ticks) }
                .onEnded { _ in
                    guard let turn = scrub else { return }
                    selection.pick(turn)
                    scrub = nil
                    jump(turn)
                }
        )
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

/// Where the top of the transcript is, set by the feed as a scroll settles and read only by the rail.
@MainActor @Observable final class TurnRailPlace {
    var place: TurnRail.Place?
}
