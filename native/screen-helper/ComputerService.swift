import AppKit
import ApplicationServices

/// `ace-screen-helper --computer`: the agent computer-use engine. Requests run one at a time on
/// the main thread, whose run loop also delivers accessibility notifications. `cancel` is
/// answered on the stdin thread, outside that queue (see ComputerServiceIO.swift).
@MainActor final class ComputerService {
    private var sessions: [pid_t: CUAppSession] = [:]
    private let catalog = CUAppCatalog()
    private var tail: Task<Void, Never>?
    private let overlay = CUOverlay()
    private let awake = CUAwake()
    nonisolated let cancellations = CUCancellations()
    nonisolated let stop = CUStopSignal()

    static let capabilities = [
        "click", "move", "type", "paste", "key", "set_value", "select_text", "scroll", "scroll_to", "action", "menu", "focus",
        "drag", "window", "wait", "wait_for", "activate", "cancel", "outline_off", "when",
    ]

    func enqueue(id: String, request: CUObject) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            defer { self.cancellations.finish(id) }
            do {
                if self.cancellations.isCancelled(id) { throw CUError("cancelled", cuCancelledMessage) }
                CUOutput.shared.reply(id, result: try await self.handle(request, id: id))
            } catch { CUOutput.shared.reply(id, error: error) }
        }
    }

    /// Puts back what the helper changed (a clipboard mid-paste, Chromium accessibility) and exits.
    func shutdown(_ code: Int32) -> Never {
        CUClipboard.restorePending()
        for session in sessions.values { session.close() }
        exit(code)
    }

    private func handle(_ request: CUObject, id: String) async throws -> CUObject {
        switch request.string("op") {
        case "hello":
            return ["version": 2, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "capabilities": Self.capabilities]
        case "apps": return apps(query: request.string("query"))
        case "resolve":
            let resolved = try catalog.resolve(request.string("app") ?? "")
            let bundleId = resolved.running?.bundleIdentifier ?? resolved.installed?.bundleId ?? ""
            let name = resolved.running?.localizedName ?? resolved.installed?.name ?? bundleId
            return ["bundleId": bundleId, "name": name, "running": resolved.running != nil]
        case "state": return try await state(request, id: id)
        case "act": return try await act(request, id: id)
        default: throw CUError("bad_request", "Unknown op.")
        }
    }

    private func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw CUError("permission_accessibility", "Computer use needs Accessibility for \"Ace Screen Helper\" in System Settings > Privacy & Security > Accessibility. Ask the person to turn it on, then try again.")
        }
    }

    private func apps(query: String?) -> CUObject {
        let running = catalog.running()
        let wanted = query?.lowercased().trimmingCharacters(in: .whitespaces) ?? ""
        func matches(_ name: String, _ id: String) -> Bool { wanted.isEmpty || name.lowercased().contains(wanted) || id.lowercased().contains(wanted) }
        let runningIds = Set(running.compactMap(\.bundleIdentifier))
        let runningRows: [CUObject] = running.compactMap { app in
            guard let id = app.bundleIdentifier, let name = app.localizedName, matches(name, id) else { return nil }
            return ["name": name, "bundleId": id, "running": true, "active": app.isActive]
        }
        let installedRows: [CUObject] = catalog.installed()
            .filter { !runningIds.contains($0.bundleId) && (wanted.isEmpty || $0.matches(partially: wanted) || $0.bundleId.lowercased().contains(wanted)) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            .prefix(wanted.isEmpty ? 0 : 50)
            .map { ["name": $0.name, "bundleId": $0.bundleId, "running": false] }
        return ["apps": runningRows + installedRows]
    }

    private func session(for query: String, launch: Bool) async throws -> (CUAppSession, launched: Bool) {
        try requireAccessibility()
        let resolved = try catalog.resolve(query)
        var running = resolved.running
        var launched = false
        if running == nil || running?.isTerminated == true {
            guard let installed = resolved.installed else { throw CUError("app_not_found", "\(query) is not running and not installed.") }
            guard launch else { throw CUError("app_not_running", "\(installed.name) is not running. Call screen_state to open it.") }
            running = try await catalog.launch(installed)
            launched = true
        }
        guard let app = running else { throw CUError("app_not_found", "\(query) could not be found.") }
        // Drop sessions of apps that quit or went unused, undoing what they changed.
        let now = cuNow()
        for (pid, session) in sessions where session.app.isTerminated || (pid != app.processIdentifier && now - session.lastUsed > 600_000_000_000) {
            session.close()
            sessions.removeValue(forKey: pid)
        }
        if let existing = sessions[app.processIdentifier] { return (existing, launched) }
        let created = CUAppSession(app: app)
        sessions[app.processIdentifier] = created
        return (created, launched)
    }

    /// The check long-running work calls: cancellation and Esc on every call, the slower
    /// system facts (lock, the person using this app) at most every 100 ms.
    private func checkpoint(id: String, session: CUAppSession, acting: Bool) -> CUCheckpoint {
        let cancellations = self.cancellations, stop = self.stop
        var throttle = CUThrottle(intervalNs: 100_000_000)
        return CUCheckpoint {
            if cancellations.isCancelled(id) { throw CUError("cancelled", cuCancelledMessage) }
            guard acting else { return }
            let stopRequested = stop.stopRequested
            guard stopRequested || throttle.due(now: cuNow()) else { return }
            let facts = MainActor.assumeIsolated {
                CUGuardFacts(locked: cuScreenLocked(), appFrontmost: session.app.isActive, secondsSinceHumanInput: cuSecondsSinceHumanInput(), stopRequested: stopRequested)
            }
            try cuGuard(facts, app: session.name)
        }
    }

    private func state(_ request: CUObject, id: String) async throws -> CUObject {
        let started = cuNow()
        let (session, launched) = try await session(for: request.string("app") ?? "", launch: true)
        session.beginRequest()
        let check = checkpoint(id: id, session: session, acting: false)
        if launched {
            // A fresh launch shows its first window shortly after it finishes launching.
            _ = await session.settler.waitForWindow(timeoutMs: 5_000) { ((cuAttribute(session.element, "AXWindows") as? [AXUIElement]) ?? []).isEmpty == false }
            try check.check()
            await session.settler.settle(minimumMs: 150, quietMs: 200, maximumMs: 1_500)
        }
        try check.check()
        let windows = try session.chooseWindow(request["window"], deadline: cuNow() + 1_500_000_000)
        var result = await session.observation(windows: windows, screenshot: request.bool("screenshot") ?? false, outline: request.bool("outline") ?? true,
                                               marks: request.bool("marks") ?? true, deadline: cuNow() + 4_000_000_000)
        try check.check()
        if launched { result["launched"] = true }
        result["elapsedMs"] = Int((cuNow() - started) / 1_000_000)
        return result
    }

    private func act(_ request: CUObject, id: String) async throws -> CUObject {
        let started = cuNow()
        let (session, _) = try await session(for: request.string("app") ?? "", launch: false)
        session.beginRequest()
        // Settling never stretches a batch past a minute, however many steps it has.
        session.settler.deadline = started + 60_000_000_000
        defer { session.settler.deadline = nil }
        if session.window == nil || request["window"] != nil { _ = try session.chooseWindow(request["window"]) }
        let focusedBefore = cuElementAttribute(session.element, "AXFocusedWindow")
        stop.begin()
        defer { stop.end() }
        let check = checkpoint(id: id, session: session, acting: true)
        var actor = CUActor(session: session)
        let overlay = self.overlay
        actor.indicate = { point in overlay.show(at: point) }
        actor.checkpoint = check.check
        var done: [String] = []
        var failure: CUObject?
        awake.hold()
        defer { awake.release() }
        let actions = request.objects("actions")
        for (index, action) in actions.enumerated() {
            do {
                try check.check()
                done.append(try await actor.run(action))
            } catch {
                let fault = error as? CUError ?? CUError("internal", String(describing: error))
                failure = ["index": index, "code": fault.code, "message": fault.message]
                break
            }
            if index < actions.count - 1 { await session.settler.settle(minimumMs: 40, quietMs: 100, maximumMs: 1_200) }
        }
        var result: CUObject = ["done": done]
        if let failure { result["error"] = failure }
        let cancelled = cancellations.isCancelled(id)
        if request.bool("observe") ?? true, !cancelled {
            await session.settler.settle(minimumMs: 60, quietMs: 150, maximumMs: 2_000)
            // Follow a window or dialog the actions opened.
            let focusedAfter = cuElementAttribute(session.element, "AXFocusedWindow")
            if let focusedAfter, focusedBefore.map({ !CFEqual($0, focusedAfter) }) ?? true {
                session.window = nil
                session.forgetMenuBar()
            }
            let windows = try session.chooseWindow(nil)
            result["state"] = await session.observation(windows: windows, screenshot: request.bool("screenshot") ?? false, outline: request.bool("outline") ?? true,
                                                        marks: request.bool("marks") ?? true, deadline: cuNow() + 4_000_000_000)
        }
        result["elapsedMs"] = Int((cuNow() - started) / 1_000_000)
        return result
    }
}
