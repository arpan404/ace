import SwiftUI

/// ace's status glyph set (the web's `StatusGlyph`): every state is the same ring on a 16-unit
/// grid (centre 8,8, radius 5.25, 1.5 stroke), and only its opening or one small interior mark
/// changes. An open ring is in motion, a closed ring has settled, a solid disc needs the person,
/// a bare dot is idle. The bridge names the state; Swift only draws it.
enum GlyphState: String, Sendable {
    case working, background, subagents, done, failed, stopped, queued, paused, idle
    case needsYou = "needs-you"

    /// The glyph a tone draws when the bridge sends only a tone (agent and step rows).
    init(tone: AceTone) {
        switch tone {
        case .working: self = .working
        case .needsYou: self = .needsYou
        case .waiting: self = .queued
        case .failed, .unresponsive: self = .failed
        case .done: self = .done
        case .background: self = .background
        case .idle: self = .idle
        }
    }
    /// Live states move while their work runs (`StatusGlyph.live`).
    var moves: Bool { self == .working || self == .background || self == .subagents }
}

/// A status glyph in its tone's colour, 12pt beside meta text by default. `live` lets a moving
/// state move; lists keep it still so nothing pulls the eye that doesn't need the person.
/// Decorative: the word beside it is what VoiceOver reads.
struct StatusGlyph: View {
    let state: GlyphState
    let tone: AceTone
    var live = false
    @ScaledMetric private var size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    init(_ state: GlyphState, tone: AceTone, size: CGFloat = 12, live: Bool = false) {
        self.state = state
        self.tone = tone
        self.live = live
        _size = ScaledMetric(wrappedValue: size, relativeTo: .caption)
    }

    private var moving: Bool { live && state.moves && !reduceMotion }

    var body: some View {
        let unit = size / 16
        let stroke = StrokeStyle(lineWidth: 1.5 * unit, lineCap: .round, lineJoin: .round)
        ZStack { drawing(stroke) }
            .frame(width: size, height: size)
            .foregroundStyle(tone.mark)
            .accessibilityHidden(true)
            .onAppear { if moving { withAnimation(motion) { phase = true } } }
            .onChange(of: moving) { _, now in
                if now { withAnimation(motion) { phase = true } } else { phase = false }
            }
    }

    private var motion: Animation {
        state == .subagents ? .easeInOut(duration: 0.9).repeatForever(autoreverses: false)
            : .easeInOut(duration: state == .background ? 1.6 : 0.9).repeatForever(autoreverses: state == .working)
    }

    @ViewBuilder private func drawing(_ stroke: StrokeStyle) -> some View {
        switch state {
        case .working:
            GlyphPath.arc(from: 300, to: 420).stroke(style: stroke).rotationEffect(.degrees(moving && phase ? 28 : 0))
            GlyphPath.arc(from: 120, to: 240).stroke(style: stroke).rotationEffect(.degrees(moving && phase ? -28 : 0))
        case .background:
            GlyphPath.arc(from: 130, to: 410).stroke(style: stroke)
            GlyphPath.dot(1.6).fill()
                .offset(x: moving && phase ? size * 0.4 : 0)
                .opacity(moving && phase ? 0 : 1)
        case .subagents:
            ZStack {
                GlyphPath.arc(from: 20, to: 100).stroke(style: stroke)
                GlyphPath.arc(from: 140, to: 220).stroke(style: stroke)
                GlyphPath.arc(from: 260, to: 340).stroke(style: stroke)
            }
            .rotationEffect(.degrees(moving && phase ? 120 : 0))
        case .needsYou:
            GlyphPath.needsYou.fill(style: FillStyle(eoFill: true))
        case .done:
            GlyphPath.ring.stroke(style: stroke)
            GlyphPath.lines([(5.6, 8.25), (7.25, 9.9), (10.45, 6.4)]).stroke(style: stroke)
        case .failed:
            GlyphPath.ring.stroke(style: stroke)
            GlyphPath.lines([(6.15, 6.15), (9.85, 9.85)]).stroke(style: stroke)
            GlyphPath.lines([(9.85, 6.15), (6.15, 9.85)]).stroke(style: stroke)
        case .stopped:
            GlyphPath.ring.stroke(style: stroke)
            GlyphPath.square.fill()
        case .queued:
            GlyphPath.arc(from: 40, to: 320).stroke(style: stroke)
        case .paused:
            GlyphPath.ring.stroke(style: stroke)
            GlyphPath.lines([(6.6, 6), (6.6, 10)]).stroke(style: stroke)
            GlyphPath.lines([(9.4, 6), (9.4, 10)]).stroke(style: stroke)
        case .idle:
            GlyphPath.dot(1.75).fill()
        }
    }
}

/// The glyph parts on the 16-unit grid, scaled into whatever frame draws them.
private struct GlyphPath: Shape {
    enum Part: Sendable {
        /// The ring from one compass bearing to another, clockwise (0 is 12 o'clock).
        case arc(Double, Double)
        case dot(CGFloat)
        case lines([CGPoint])
        case square
        /// A solid disc with an exclamation mark cut out of it (filled even-odd).
        case needsYou
    }
    let part: Part

    static let ring = GlyphPath(part: .arc(0, 360))
    static let square = GlyphPath(part: .square)
    static let needsYou = GlyphPath(part: .needsYou)
    static func arc(from start: Double, to end: Double) -> GlyphPath { GlyphPath(part: .arc(start, end)) }
    static func dot(_ radius: CGFloat) -> GlyphPath { GlyphPath(part: .dot(radius)) }
    static func lines(_ points: [(CGFloat, CGFloat)]) -> GlyphPath { GlyphPath(part: .lines(points.map { CGPoint(x: $0.0, y: $0.1) })) }

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 16
        let origin = CGPoint(x: rect.midX - 8 * unit, y: rect.midY - 8 * unit)
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * unit, y: origin.y + y * unit) }
        func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> CGRect {
            CGRect(x: origin.x + (x - r) * unit, y: origin.y + (y - r) * unit, width: 2 * r * unit, height: 2 * r * unit)
        }
        var path = Path()
        switch part {
        case let .arc(start, end):
            path.addArc(center: point(8, 8), radius: 5.25 * unit, startAngle: .degrees(start - 90), endAngle: .degrees(end - 90), clockwise: false)
        case let .dot(radius):
            path.addEllipse(in: circle(8, 8, radius))
        case let .lines(points):
            path.addLines(points.map { point($0.x, $0.y) })
        case .square:
            path.addRoundedRect(in: CGRect(origin: point(6, 6), size: CGSize(width: 4 * unit, height: 4 * unit)),
                                cornerSize: CGSize(width: 0.8 * unit, height: 0.8 * unit))
        case .needsYou:
            path.addEllipse(in: circle(8, 8, 6))
            path.addRect(CGRect(origin: point(7.2, 4.6), size: CGSize(width: 1.6 * unit, height: 4.7 * unit)))
            path.addEllipse(in: circle(8, 11.3, 0.95))
        }
        return path
    }
}
