import AppKit
import ApplicationServices

/// `ace-screen-helper --computer`: the agent computer-use engine. Requests run one at a time on
/// the main thread, whose run loop also delivers accessibility notifications.
@MainActor final class ComputerService {
    private var sessions: [pid_t: CUAppSession] = [:]
    private let catalog = CUAppCatalog()
    private var tail: Task<Void, Never>?
    private let overlay = CUOverlay()
    private let awake = CUAwake()

    static func run() -> Never {
        let service = ComputerService()
        // Accessory: no Dock icon or app switcher entry, but it may show the agent marker.
        NSApplication.shared.setActivationPolicy(.accessory)
        service.overlay.start()
        Thread.detachNewThread {
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(STDIN_FILENO, &buffer, buffer.count)
                if count <= 0 { exit(0) }
                for byte in buffer.prefix(count) {
                    if byte == 10 {
                        let line = pending
                        pending.removeAll(keepingCapacity: true)
                        DispatchQueue.main.async { MainActor.assumeIsolated { service.enqueue(line) } }
                    } else {
                        pending.append(byte)
                        if pending.count > 4 * 1024 * 1024 { exit(2) }
                    }
                }
            }
        }
        RunLoop.main.run()
        exit(0)
    }

    private func enqueue(_ line: Data) {
        guard let request = (try? JSONSerialization.jsonObject(with: line)) as? CUObject, let id = request.string("id") else { return }
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            do { CUOutput.shared.reply(id, result: try await self.handle(request)) }
            catch { CUOutput.shared.reply(id, error: error) }
        }
    }

    private func handle(_ request: CUObject) async throws -> CUObject {
        switch request.string("op") {
        case "hello": return ["version": 1, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
        case "apps": return apps(query: request.string("query"))
        case "resolve":
            let resolved = try catalog.resolve(request.string("app") ?? "")
            let id = resolved.running?.bundleIdentifier ?? resolved.installed?.bundleId ?? ""
            let name = resolved.running?.localizedName ?? resolved.installed?.name ?? id
            return ["bundleId": id, "name": name, "running": resolved.running != nil]
        case "state": return try await state(request)
        case "act": return try await act(request)
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
            .filter { !runningIds.contains($0.bundleId) && matches($0.name, $0.bundleId) }
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
        for (pid, session) in sessions where session.app.isTerminated { session.settler.close(); sessions.removeValue(forKey: pid) }
        if let existing = sessions[app.processIdentifier] { return (existing, launched) }
        let created = CUAppSession(app: app)
        sessions[app.processIdentifier] = created
        return (created, launched)
    }

    private func state(_ request: CUObject) async throws -> CUObject {
        let (session, launched) = try await session(for: request.string("app") ?? "", launch: true)
        if launched {
            // A fresh launch shows its first window shortly after it finishes launching.
            for _ in 0..<40 where cuWindows(pid: session.pid).isEmpty { try? await Task.sleep(nanoseconds: 100_000_000) }
            await session.settler.settle(minimumMs: 300, quietMs: 300, maximumMs: 3_000)
        }
        let windows = try session.chooseWindow(request["window"])
        return try await observation(session, windows: windows, screenshot: request.bool("screenshot") ?? false, marks: request.bool("marks") ?? true, launched: launched)
    }

    private func observation(_ session: CUAppSession, windows: [CUWindow], screenshot: Bool, marks: Bool = true, launched: Bool = false) async throws -> CUObject {
        var result = session.observe(windows: windows)
        if launched { result["launched"] = true }
        // Chromium builds its tree a moment after the first request; look once more.
        if (result["nodes"] as? [Any])?.count ?? 0 < 6, session.window != nil {
            AXUIElementSetAttributeValue(session.element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            await session.settler.settle(minimumMs: 800, quietMs: 300, maximumMs: 2_500)
            result = session.observe(windows: cuWindows(pid: session.pid))
            if launched { result["launched"] = true }
        }
        if screenshot {
            guard let number = session.window?.number else { throw CUError("no_window", "\(session.name) has no window to capture.") }
            if session.window?.minimized == true { throw CUError("window_minimized", "The window is minimized, so it can't be captured. Use the outline, or ask the person to restore it.") }
            do {
                let nodes = session.lastNodes, frame = session.window?.frame ?? .zero
                let image = try await cuCaptureWindow(number, marks: { scale in marks ? cuMarks(nodes: nodes, window: frame, scale: scale) : [] })
                session.screenshotScale = image.scale
                result["screenshot"] = ["jpeg": image.jpeg.base64EncodedString(), "width": image.width, "height": image.height]
            } catch {
                // The outline is still useful; say why there is no picture.
                let fault = error as? CUError
                result["screenshotError"] = fault?.message ?? "macOS would not capture this window (\((error as NSError).localizedDescription))."
            }
        }
        return result
    }

    private func act(_ request: CUObject) async throws -> CUObject {
        let (session, _) = try await session(for: request.string("app") ?? "", launch: false)
        if session.window == nil || request["window"] != nil { _ = try session.chooseWindow(request["window"]) }
        let focusedBefore = cuAttribute(session.element, "AXFocusedWindow")
        var actor = CUActor(session: session)
        let overlay = self.overlay
        actor.indicate = { point in overlay.show(at: point) }
        var done: [String] = []
        var failure: CUObject?
        awake.hold()
        defer { awake.release() }
        for (index, action) in request.objects("actions").enumerated() {
            overlay.acting()
            do {
                let facts = CUGuardFacts(locked: cuScreenLocked(), appFrontmost: session.app.isActive,
                                         secondsSinceHumanInput: cuSecondsSinceHumanInput(), stopRequested: overlay.stopRequested)
                do { try cuGuard(facts, app: session.name) } catch { _ = overlay.consumeStop(); throw error }
                done.append(try await actor.run(action))
                overlay.acting()
            }
            catch {
                let fault = error as? CUError ?? CUError("internal", String(describing: error))
                failure = ["index": index, "code": fault.code, "message": fault.message]
                break
            }
            if index < request.objects("actions").count - 1 { await session.settler.settle(minimumMs: 60, quietMs: 120, maximumMs: 1_500) }
        }
        var result: CUObject = ["done": done]
        if let failure { result["error"] = failure }
        if request.bool("observe") ?? true {
            await session.settler.settle()
            // Follow a window or dialog the actions opened.
            let focusedAfter = cuAttribute(session.element, "AXFocusedWindow")
            if let focusedAfter, focusedBefore.map({ !CFEqual($0, focusedAfter) }) ?? true { session.window = nil }
            let windows = try session.chooseWindow(nil)
            let observed = try await observation(session, windows: windows, screenshot: request.bool("screenshot") ?? false, marks: request.bool("marks") ?? true)
            result["state"] = observed
        }
        return result
    }
}
