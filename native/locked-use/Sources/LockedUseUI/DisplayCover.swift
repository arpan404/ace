import AppKit
import CoreGraphics
import LockedUseCore

public enum LockedUseCoverError: Error { case noDisplays, incompleteCoverage, topologyChanged }

private final class LockedUseCoverPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The GUI shell for display covers, kept separate from authorization. A returned topology
/// only acknowledges these panels. The caller must independently prove input suppression,
/// correct window ordering across Spaces, and crash-relock readiness before arming a permit.
@MainActor public final class LockedUseDisplayCover {
    private var panels: [CGDirectDisplayID: NSPanel] = [:]
    private var observer: NSObjectProtocol?
    private var topology: [LockedUseDisplaySurface] = []
    private var generation: UInt64 = 0
    private var usable = false
    private let lost: () -> Void

    public init(protectionLost: @escaping () -> Void) { lost = protectionLost }

    /// Planning only. prepare and each heartbeat re-read the actual topology before
    /// any permit can be granted; this snapshot is never protection readiness.
    public func plannedDisplays() throws -> LockedUseDisplays {
        guard panels.isEmpty, generation < UInt64.max else { throw LockedUseCoverError.topologyChanged }
        return try LockedUseDisplays(ids: Set(Self.displays().map(\.displayID)), generation: generation + 1)
    }

    public func prepare() throws -> LockedUseDisplays {
        guard panels.isEmpty else { throw LockedUseCoverError.topologyChanged }
        let current = try Self.displays()
        guard generation < UInt64.max else { throw LockedUseCoverError.topologyChanged }
        generation += 1
        topology = current
        for screen in NSScreen.screens {
            guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else { continue }
            let panel = LockedUseCoverPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.level = .screenSaver
            panel.isOpaque = true
            panel.backgroundColor = .windowBackgroundColor
            panel.hasShadow = false
            panel.hidesOnDeactivate = false
            panel.ignoresMouseEvents = false
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            panel.canBecomeVisibleWithoutLogin = true
            panel.contentView = LockedUseCoverView(frame: CGRect(origin: .zero, size: screen.frame.size))
            panel.orderFrontRegardless()
            panel.displayIfNeeded()
            panels[id] = panel
        }
        guard lockedUseHasCompleteCoverage(current, covered: Set(panels.keys)), panels.values.allSatisfy(\.isVisible) else {
            removeAfterConfirmedLock()
            throw LockedUseCoverError.incompleteCoverage
        }
        usable = true
        observer = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.invalidate() }
        }
        return try LockedUseDisplays(ids: Set(current.map(\.displayID)), generation: generation)
    }

    /// Call immediately before authorization as well as on every protection heartbeat.
    public func topologyAcknowledgement() throws -> LockedUseDisplays {
        guard usable, try Self.displays() == topology, panels.values.allSatisfy({ $0.isVisible && $0.alphaValue == 1 }) else {
            invalidate()
            throw LockedUseCoverError.topologyChanged
        }
        return try LockedUseDisplays(ids: Set(topology.map(\.displayID)), generation: generation)
    }

    public func showWorking() {
        for panel in panels.values { (panel.contentView as? LockedUseCoverView)?.showWorking() }
    }

    public func showRelocking() {
        for panel in panels.values { (panel.contentView as? LockedUseCoverView)?.showRelocking() }
    }

    /// The authority's removeCovers effect is the only production caller. This class never
    /// infers a confirmed OS lock from an input event, a timeout, or a tool completion.
    public func removeAfterConfirmedLock() {
        usable = false
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        for panel in panels.values { panel.close() }
        panels.removeAll()
        topology.removeAll()
    }

    private func invalidate() {
        guard usable else { return }
        usable = false
        // Keep the old covers in place. The authority must stop, relock, and only then tear
        // down; this renderer cannot secure a newly attached display on its own.
        lost()
    }

    private static func displays() throws -> [LockedUseDisplaySurface] {
        var expected: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &expected) == .success, expected > 0, expected <= 32 else {
            throw LockedUseCoverError.noDisplays
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(expected) + 1)
        var count: UInt32 = 0
        var confirmed: UInt32 = 0
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success, count == expected,
              CGGetOnlineDisplayList(0, nil, &confirmed) == .success, confirmed == count else {
            throw LockedUseCoverError.topologyChanged
        }
        return ids.prefix(Int(count)).sorted().map { id in
            let mirror = CGDisplayMirrorsDisplay(id)
            return LockedUseDisplaySurface(displayID: id, renderedBy: mirror == kCGNullDirectDisplay ? id : mirror)
        }
    }
}
