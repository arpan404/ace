/// Why the broker refused a coordinator registration.
public enum LockedUseRegistrationRefusal: Equatable, Sendable {
    /// Another coordinator is linked. The broker binds to one and never silently replaces it.
    case anotherIsLinked
    /// A permit was granted recently enough that its attempt may still be working or
    /// relocking, even if its coordinator's link has since dropped.
    case attemptMayBeLive
    /// The registering process was not spawned by a trusted ace daemon.
    case untrustedAncestry
}

/// Pure registration rules for the root broker's single coordinator slot. The broker holds
/// at most one coordinator. A second one is refused while the first is linked, and every
/// newcomer is refused until `attemptWindow` has passed since the last granted permit, so
/// nobody can take over the plug-in's answers in the middle of an attempt, including by
/// killing the coordinator that holds it. The guardian relocks a dead coordinator's attempt.
public struct LockedUseCoordinatorSlot<Holder: Equatable> {
    /// Longer than the authority's sixty-second work bound plus the guardian's relock retries.
    public static var defaultAttemptWindow: UInt64 { 90_000_000_000 }

    public private(set) var holder: Holder?
    private let attemptWindow: UInt64
    private var lastGrant: UInt64?

    public init(attemptWindow: UInt64 = Self.defaultAttemptWindow) {
        self.attemptWindow = attemptWindow
    }

    /// `trusted` is the ancestry verdict for the registering process. Registering again on
    /// the current holder's own link is accepted.
    public mutating func register(_ candidate: Holder, trusted: Bool, now: UInt64) -> LockedUseRegistrationRefusal? {
        if let holder, holder == candidate { return nil }
        guard trusted else { return .untrustedAncestry }
        guard holder == nil else { return .anotherIsLinked }
        if let lastGrant, now &- lastGrant < attemptWindow { return .attemptMayBeLive }
        holder = candidate
        return nil
    }

    /// The plug-in was told yes on `holder`'s answer at `now`.
    public mutating func granted(by candidate: Holder, now: UInt64) {
        guard let holder, holder == candidate else { return }
        lastGrant = now
    }

    /// The holder's link is gone; a newcomer may register once no attempt can be live.
    public mutating func dropped(_ candidate: Holder) {
        if let holder, holder == candidate { self.holder = nil }
    }
}
