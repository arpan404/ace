import ApplicationServices
import Foundation

/// Watches the person's keyboard for Esc with a listen-only session event tap on its own
/// thread, so it fires even while the main thread is busy acting. It never sees or alters
/// other keys' effects: the tap only listens. Events this helper posts are ignored.
final class CUEscapeWatcher: @unchecked Sendable {
    private let signal: CUStopSignal
    private var tap: CFMachPort?

    init(signal: CUStopSignal) { self.signal = signal }

    /// False when macOS refused the tap (no Accessibility or Input Monitoring yet).
    @discardableResult func start() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        var started = false
        let thread = Thread { [self] in
            let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                               eventsOfInterest: mask, callback: cuEscapeTapCallback, userInfo: refcon) else {
                ready.signal()
                return
            }
            tap = port
            started = true
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        thread.name = "ace-escape-watcher"
        thread.start()
        _ = ready.wait(timeout: .now() + 1)
        return started
    }

    fileprivate func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53 else { return }
        // Keys the helper posts itself carry its pid; only the person's Esc stops the agent.
        if event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid()) { return }
        signal.escapePressed()
    }
}

private func cuEscapeTapCallback(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let refcon { Unmanaged<CUEscapeWatcher>.fromOpaque(refcon).takeUnretainedValue().handle(type, event) }
    return Unmanaged.passUnretained(event)
}
