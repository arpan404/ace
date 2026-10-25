import AppKit
import LockedUseCore

public enum LockedUseInputError: Error { case unavailable }

/// Suppresses takeover input until an independent owner confirms the OS relocked. A tap
/// timeout disables authorization readiness instead of silently re-enabling the tap.
@MainActor public final class LockedUseInputGuard {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let agentProcessIDs: Set<Int32>
    private let takeover: () -> Void
    private let protectionLost: () -> Void
    private var tookOver = false
    public private(set) var ready = false

    public init(agentProcessIDs: Set<Int32>, takeover: @escaping () -> Void, protectionLost: @escaping () -> Void) {
        self.agentProcessIDs = agentProcessIDs.filter { $0 > 0 }
        self.takeover = takeover
        self.protectionLost = protectionLost
    }

    public func start() throws {
        guard tap == nil, CGPreflightPostEventAccess() else { throw LockedUseInputError.unavailable }
        let events: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: { _, type, event, context in
                guard let context else { return nil }
                return MainActor.assumeIsolated {
                    Unmanaged<LockedUseInputGuard>.fromOpaque(context).takeUnretainedValue().receive(type, event: event)
                }
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(nil, tap, 0) else { throw LockedUseInputError.unavailable }
        self.tap = tap
        self.source = source
        tookOver = false
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            stopAfterConfirmedLock()
            throw LockedUseInputError.unavailable
        }
        ready = true
    }

    /// Call only after OS lock confirmation, alongside the removeCovers effect.
    public func stopAfterConfirmedLock() {
        ready = false
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes); self.source = nil }
        if let tap { CFMachPortInvalidate(tap); self.tap = nil }
    }

    deinit {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
    }

    private func receive(_ type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if ready { ready = false; protectionLost() }
            return nil
        }
        let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
        let sourcePID = Int32(exactly: pid) ?? 0
        if tookOver || lockedUseIsTakeover(sourcePID: sourcePID, agentProcessIDs: agentProcessIDs) {
            if !tookOver { tookOver = true; ready = false; takeover() }
            return nil
        }
        return Unmanaged.passUnretained(event)
    }
}
