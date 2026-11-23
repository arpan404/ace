import Foundation

enum SpadeTabFrame: String {
    case rest = "tab-spade"
    case left = "tab-spade-look-1"
    case right = "tab-spade-look-2"
    case blink = "tab-spade-blink"

    /// Sample each glance transition at its midpoint. Hold one closed frame around the blink peak.
    private static let looks: [(Double, Self)] = zip(SpadeMotion.lookMoves, [Self.left, .right, .rest]).map {
        let (window, frame) = $0
        return ((window.lowerBound + window.upperBound) / 2 * SpadeMotion.lookCycle, frame)
    }
    private static let blinkStart = 0.49 * SpadeMotion.blinkCycle
    private static let blinkEnd = 0.51 * SpadeMotion.blinkCycle

    /// The current frame and the next time either cycle can change it, relative to motion start.
    static func sample(at seconds: Double) -> (frame: Self, next: Double) {
        let lookBase = (seconds / SpadeMotion.lookCycle).rounded(.down) * SpadeMotion.lookCycle
        let blinkBase = (seconds / SpadeMotion.blinkCycle).rounded(.down) * SpadeMotion.blinkCycle
        let start = blinkBase + blinkStart
        let end = blinkBase + blinkEnd
        if seconds >= start && seconds < end { return (.blink, end) }

        var frame = Self.rest
        var next = lookBase + SpadeMotion.lookCycle + looks[0].0
        for (offset, look) in looks {
            let time = lookBase + offset
            if seconds < time {
                next = time
                break
            }
            frame = look
        }
        let nextBlink = seconds < start ? start : start + SpadeMotion.blinkCycle
        return (frame, min(next, nextBlink))
    }
}
