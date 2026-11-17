import SwiftUI

/// A step still in flight, as the web's running step row reads it: its verb shimmers and its time
/// counts up from when the call started, until it settles and folds into the group before it.
/// One waiting on an approval steps aside for the request, so neither shows. Pure: the clock and
/// Reduce Motion come in.
struct StepInFlight: Equatable {
    let step: StepLine
    var running: Bool { !step.settled && step.awaiting != true }
    /// The verb's shimmer is the only motion ace adds here; Reduce Motion keeps it still.
    func shimmers(reduceMotion: Bool) -> Bool { running && !reduceMotion }
    /// "7s", "1m 34s" since the call started; nil once it settles or when its start is unknown.
    func elapsed(now: Date) -> String? {
        guard running, let startedAt = step.startedAt, startedAt > 0 else { return nil }
        return ActivityTime.running(since: Date(timeIntervalSince1970: startedAt / 1000), now: now)
    }
}

/// A light band passing across the words of work under way, once every `period`.
enum Shimmer {
    static let period: TimeInterval = 2
    /// Where the band is at `date`, from 0 (before the words) to 1 (past them).
    static func phase(at date: Date) -> Double {
        let elapsed = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
        return (elapsed < 0 ? elapsed + period : elapsed) / period
    }
}

extension View {
    /// The words shimmer while `active`; otherwise they draw as they are.
    func stepShimmer(_ active: Bool) -> some View { modifier(ShimmerModifier(active: active)) }
}

private struct ShimmerModifier: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                content.mask { band(Shimmer.phase(at: context.date)) }
            }
        } else {
            content
        }
    }
    /// The words at a dimmer tier, full strength where the band is.
    private func band(_ phase: Double) -> some View {
        let centre = phase * 2 - 0.5
        let dim = Color.black.opacity(0.45)
        return LinearGradient(stops: [.init(color: dim, location: 0),
                                      .init(color: dim, location: max(0, centre - 0.25)),
                                      .init(color: .black, location: min(1, max(0, centre))),
                                      .init(color: dim, location: min(1, centre + 0.25)),
                                      .init(color: dim, location: 1)],
                              startPoint: .leading, endPoint: .trailing)
    }
}

/// A step's time while it runs, ticking each second; nothing once it settles.
struct StepElapsed: View {
    let inFlight: StepInFlight
    var body: some View {
        if inFlight.elapsed(now: .now) != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(inFlight.elapsed(now: context.date) ?? "")
            }
            .monospacedDigit()
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .accessibilityLabel("Elapsed time")
        }
    }
}
