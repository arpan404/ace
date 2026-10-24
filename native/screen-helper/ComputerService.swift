import AppKit
import ApplicationServices

/// `ace-screen-helper --computer`: the agent computer-use engine. Requests run one at a time on
/// the main thread, whose run loop also delivers accessibility notifications. `cancel` is
/// answered on the stdin thread, outside that queue (see ComputerServiceIO.swift).
@MainActor final class ComputerService {
    private var sessions: [pid_t: CUAppSession] = [:]
    private var resolvedQueries: [String: pid_t] = [:]
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
            } catch {
                // A failed observation or batch ends the keep-awake lease; a failed lookup does not.
                if ["state", "act"].contains(request.string("op") ?? "") { self.awake.release() }
                CUOutput.shared.reply(id, error: error)
            }
        }
    }

    /// Puts back what the helper changed (a clipboard mid-paste, Chromium accessibility) and exits.
    func shutdown(_ code: Int32) -> Never {
        overlay.hide()
        awake.release()
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
        case "state", "act":
            try awake.hold()
            var keepAwake = false
            defer { if keepAwake { awake.linger() } else { awake.release() } }
            let result = try await (request.string("op") == "state" ? state(request, id: id) : act(request, id: id))
            keepAwake = result["error"] == nil && !cancellations.isCancelled(id)
            return result
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
        // The same name keeps naming the same running app while it lives; skip the lookup.
        if let pid = resolvedQueries[query], let known = sessions[pid], !known.app.isTerminated { return (known, false) }
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
        resolvedQueries = resolvedQueries.filter { sessions[$0.value] != nil }
        resolvedQueries[query] = app.processIdentifier
        if let existing = sessions[app.processIdentifier] { return (existing, launched) }
        let created = CUAppSession(app: app)
        sessions[app.processIdentifier] = created
        return (created, launched)
    }

    /// The check long-running work calls: cancellation and Esc on every call, the slower
    /// system facts (lock, the person using this app) at most every 100 ms.
    private func checkpoint(id: String, session: CUAppSession, acting: Bool, record: ((UInt64) -> Void)? = nil) -> CUCheckpoint {
        let cancellations = self.cancellations, stop = self.stop
        var throttle = CUThrottle(intervalNs: 100_000_000)
        var checkedAction = -1
        var lastRefusal: CUError?
        return CUCheckpoint {
            let started = record == nil ? 0 : cuNow()
            defer { if let record { record(cuNow() - started) } }
            if cancellations.isCancelled(id) { throw CUError("cancelled", cuCancelledMessage) }
            guard acting else { return }
            let stopRequested = stop.stopRequested
            let revision = MainActor.assumeIsolated { session.actionRevision }
            guard stopRequested || checkedAction != revision || throttle.due(now: cuNow()) else {
                if let lastRefusal { throw lastRefusal }
                return
            }
            checkedAction = revision
            let facts = MainActor.assumeIsolated {
                let status = cuSessionStatus()
                return CUGuardFacts(locked: status == .locked, appFrontmost: session.app.isActive, secondsSinceHumanInput: cuSecondsSinceHumanInput(), stopRequested: stopRequested,
                             sessionAvailable: status != .unavailable)
            }
            do {
                try cuGuard(facts, app: session.name, conflict: { MainActor.assumeIsolated { session.conflictsWithHuman } })
                lastRefusal = nil
            } catch let fault as CUError {
                lastRefusal = fault
                throw fault
            }
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
        let resolved = cuNow()
        let windows = try session.chooseWindow(request["window"], deadline: cuNow() + 1_500_000_000)
        let chosen = cuNow()
        var result = await session.observation(windows: windows, screenshot: request.bool("screenshot") ?? false, outline: request.bool("outline") ?? true,
                                               marks: request.bool("marks") ?? true, deadline: cuNow() + 4_000_000_000,
                                               find: request.int("findFormat") == 1 ? request.string("find") : nil)
        try check.check()
        if launched { result["launched"] = true }
        if cuTimingsEnabled, var timings = result["timings"] as? CUObject {
            timings["sessionMs"] = cuMs(resolved - started)
            timings["windowsMs"] = cuMs(chosen - resolved)
            result["timings"] = timings
        }
        result["elapsedMs"] = Int((cuNow() - started) / 1_000_000)
        return result
    }

    private func act(_ request: CUObject, id: String) async throws -> CUObject {
        let started = cuNow()
        let (session, _) = try await session(for: request.string("app") ?? "", launch: false)
        let resolved = cuNow()
        session.beginRequest()
        defer { session.endRequest() }
        // Settling never stretches a batch past a minute, however many steps it has.
        session.settler.deadline = started + 60_000_000_000
        defer { session.settler.deadline = nil }
        // Visibility, position and minimization can change between calls, including at lock.
        _ = try session.chooseWindow(request["window"])
        let chosen = cuNow()
        let focusedBefore = session.notResponding ? nil : cuElementAttribute(session.element, "AXFocusedWindow")
        stop.begin()
        defer { stop.end() }
        var guardNs: UInt64 = 0
        let check = checkpoint(id: id, session: session, acting: true, record: cuTimingsEnabled ? { guardNs += $0 } : nil)
        var actor = CUActor(session: session)
        let overlay = self.overlay
        actor.indicate = { point in overlay.show(at: point, window: session.window) }
        actor.checkpoint = check.check
        var done: [String] = []
        var failure: CUObject?
        var actionNs: UInt64 = 0, betweenSettleNs: UInt64 = 0, finalSettleNs: UInt64 = 0, observationNs: UInt64 = 0
        if !cuScreenLocked() { try awake.keepDisplayAwake() }
        let actions = request.objects("actions")
        for (index, action) in actions.enumerated() {
            let stepStarted = cuNow()
            do {
                done.append(try await actor.run(action))
            } catch {
                actionNs += cuNow() - stepStarted
                let fault = error as? CUError ?? CUError("internal", String(describing: error))
                failure = ["index": index, "code": fault.code, "message": fault.message]
                break
            }
            actionNs += cuNow() - stepStarted
            if index < actions.count - 1 {
                let settling = cuNow()
                if !cuNeedsSettleAfter(action, next: actions[index + 1], skipped: actor.skipped) {
                    // Confirmed edits, skipped actions and explicit waits need no extra
                    // quiet interval. Yield so cancel, Esc and notifications keep flowing.
                    try? await Task.sleep(nanoseconds: 1_000_000)
                } else {
                    await session.settler.settle(minimumMs: 40, quietMs: 100, respondedQuietMs: 40, maximumMs: 1_200)
                }
                betweenSettleNs += cuNow() - settling
            }
        }
        session.endRequest()
        if failure != nil { overlay.hide() }
        var result: CUObject = ["done": done]
        if let failure { result["error"] = failure }
        let cancelled = cancellations.isCancelled(id)
        if request.bool("observe") ?? true, !cancelled {
            let settling = cuNow()
            if !session.notResponding { await session.settler.settle(minimumMs: 60, quietMs: 150, respondedQuietMs: 60, maximumMs: 2_000) }
            finalSettleNs = cuNow() - settling
            let observing = cuNow()
            // Follow a window or dialog the actions opened.
            let focusedAfter = session.notResponding ? nil : cuElementAttribute(session.element, "AXFocusedWindow")
            if let focusedAfter, focusedBefore.map({ !CFEqual($0, focusedAfter) }) ?? true {
                session.window = nil
                session.forgetMenuBar()
            }
            let windows = try session.chooseWindow(nil)
            result["state"] = await session.observation(windows: windows, screenshot: request.bool("screenshot") ?? false, outline: request.bool("outline") ?? true,
                                                        marks: request.bool("marks") ?? true, deadline: cuNow() + 4_000_000_000)
            observationNs = cuNow() - observing
        }
        if cuTimingsEnabled {
            result["timings"] = ["sessionMs": cuMs(resolved - started), "windowsMs": cuMs(chosen - resolved),
                "actionMs": cuMs(actionNs), "guardMs": cuMs(guardNs), "betweenSettleMs": cuMs(betweenSettleNs),
                "finalSettleMs": cuMs(finalSettleNs), "observationMs": cuMs(observationNs)]
        }
        result["elapsedMs"] = Int((cuNow() - started) / 1_000_000)
        return result
    }
}
