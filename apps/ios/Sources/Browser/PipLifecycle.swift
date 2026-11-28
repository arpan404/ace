import Foundation

/// One live view's picture-in-picture through AVKit's asynchronous start and stop, fenced to the
/// view subscription that started it (pure). `BrowserPipRule` says whether the page may float;
/// this says what to do as AVKit's callbacks and the rule's answers arrive in any order.
///
/// - A float is starting from the request (leaving the Browser) or AVKit's own start (leaving the
///   app), and active from its did-start. Both count as floating for the rule's recheck.
/// - The rule failing while it starts or floats stops it, and a stream kept open for it closes at
///   once, without waiting for AVKit to report the stop.
/// - A did-start that comes after the float was cancelled, or for another subscription, stops it.
/// - Callbacks for another subscription change nothing else.
struct PipLifecycle {
    enum Phase: Equatable {
        case idle
        case starting(UUID)
        case active(UUID)
    }
    enum Command: Equatable {
        /// Ask AVKit to float the page.
        case start
        /// Ask AVKit to end the float.
        case stop
        /// Close the stream kept open for the float.
        case closeStream
        /// Turn the page's sound off on this phone (nothing shows the page any more).
        case mute
    }
    private(set) var phase: Phase = .idle
    /// The subscription whose stream stays open only for the float (the person left the Browser).
    private(set) var kept: UUID?

    /// Starting or floating: the page is meant to be on screen in picture-in-picture.
    var floating: Bool { phase != .idle }
    var active: Bool { if case .active = phase { true } else { false } }

    /// The person left the Browser of `subscription`: float it when the rule holds, else close it.
    mutating func leave(_ subscription: UUID, eligible: Bool) -> [Command] {
        guard eligible else { return [.closeStream] }
        phase = .starting(subscription)
        kept = subscription
        return [.start]
    }
    /// AVKit is starting a float: its own as the app leaves, the requested one, or a late start
    /// of one cancelled meanwhile, which the rule then no longer allows and is stopped.
    mutating func willStart(_ subscription: UUID?, eligible: Bool) -> [Command] {
        guard let subscription else { return [.stop] }
        if phase == .starting(subscription) || phase == .active(subscription) { return [] }
        guard phase == .idle, eligible else { return [.stop] }
        phase = .starting(subscription)
        return []
    }
    /// AVKit's float is on screen. One cancelled meanwhile, stale, or no longer allowed is stopped.
    mutating func didStart(_ subscription: UUID?, eligible: Bool) -> [Command] {
        guard let subscription, phase == .starting(subscription) else { return [.stop] }
        guard eligible else { return cancel() }
        phase = .active(subscription)
        return []
    }
    /// AVKit couldn't float `subscription`'s page.
    mutating func failed(_ subscription: UUID?) -> [Command] {
        guard let subscription, phase == .starting(subscription) else { return [] }
        phase = .idle
        return closeKept(subscription)
    }
    /// AVKit's float ended: `restore` when the person asked to go back to the page, `onScreen` when
    /// the Browser shows it again.
    mutating func ended(_ subscription: UUID?, restore: Bool, onScreen: Bool) -> [Command] {
        guard let subscription, phase == .starting(subscription) || phase == .active(subscription) else { return [] }
        phase = .idle
        if kept == subscription { return closeKept(subscription) }
        return restore || onScreen ? [] : [.mute]
    }
    /// The rule was read again: a float it no longer allows ends now.
    mutating func recheck(eligible: Bool) -> [Command] {
        guard floating, !eligible else { return [] }
        return cancel()
    }
    /// The view closed, or the Browser shows again: nothing floats, nothing is kept.
    mutating func reset() -> [Command] {
        let wasFloating = floating
        phase = .idle
        kept = nil
        return wasFloating ? [.stop] : []
    }

    private mutating func cancel() -> [Command] {
        let subscription: UUID? = switch phase {
        case .starting(let id), .active(let id): id
        case .idle: nil
        }
        phase = .idle
        guard let subscription else { return [.stop] }
        return [.stop] + closeKept(subscription)
    }
    private mutating func closeKept(_ subscription: UUID) -> [Command] {
        guard kept == subscription else { return [] }
        kept = nil
        return [.closeStream]
    }
}
