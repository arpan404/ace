import Foundation
import AppKit
import Darwin

@main struct ScreenHelper {
    @MainActor static func main() async {
        // Before anything else: macOS must attribute permissions to this helper, not its launcher.
        Responsibility.disclaimIfNeeded()
        let arguments = CommandLine.arguments.filter { $0 != "--inherit-responsibility" }
        guard arguments.count == 3, ["--socket", "--endpoint"].contains(arguments[1]) else { exit(2) }
        let argument = arguments[2]
        guard arguments[1] == "--socket" || argument.hasPrefix("unix:/") else { exit(2) }
        let path = arguments[1] == "--socket" ? argument : String(argument.dropFirst(5))
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        // Input checks stay short. Tree/find inspections install a scoped larger budget.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.05)
        do {
            let runtime = NativeRuntime(nanos: { DispatchTime.now().uptimeNanoseconds }, milliseconds: { Date().timeIntervalSince1970 * 1000 }, uptime: { ProcessInfo.processInfo.systemUptime }, inputAllowed: { AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() })
            let writer = try FrameWriter(path: path)
            let service = HelperService(writer: writer, runtime: runtime)
            let scheduler = CommandScheduler()
            let commands = AsyncStream<Data>(bufferingPolicy: .bufferingOldest(32)) { continuation in
                DispatchQueue.global().async {
                    var pending = Data()
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    while true {
                        let count = read(STDIN_FILENO, &buffer, buffer.count)
                        if count <= 0 { continuation.finish(); return }
                        for byte in buffer.prefix(count) {
                            if byte == 10 {
                                if case .dropped = continuation.yield(pending) { exit(2) }
                                pending.removeAll(keepingCapacity: true)
                            } else {
                                pending.append(byte)
                                if pending.count > 64 * 1024 { exit(2) }
                            }
                        }
                    }
                }
            }
            for await line in commands {
                guard let request = try? JSONDecoder().decode(Request.self, from: line),
                      (request.version == 1 || request.version == 2), !request.id.isEmpty, request.id.count <= 64 else { exit(2) }
                let key = service.lane(request)
                let coordinated = request.mode == "foreground" || request.humanDeviceInput == true || request.action?.kind == "paste" && request.mode == "foreground"
                guard scheduler.submit(key: key, coordinated: coordinated, operation: { await service.handle(request) }) else {
                    reply(request, error: HelperError("Helper command queue limit", code: "busy")); continue
                }
            }
            await scheduler.drain()
            try await service.stop()

        } catch { FileHandle.standardError.write(Data("screen-helper: \(error)\n".utf8)); exit(1) }
    }
}

@MainActor final class HelperService {
    let writer: FrameWriter
    let runtime: NativeRuntime
    let inventory: Capture
    var sessions: [String: (Capture, Accessibility)] = [:]
    private var lastPermissions: [String: Bool]?
    private func publishPermissionChanges() {
        let value = permissions()
        defer { lastPermissions = value }
        guard let previous = lastPermissions, previous != value else { return }
        if let data = try? JSONSerialization.data(withJSONObject: ["event": "permissions.changed", "permissions": value]) { FileHandle.standardOutput.write(data + Data([10])) }
    }
    private var startingSessions = Set<String>()
    private var startingBundles = Set<String>()
    init(writer: FrameWriter, runtime: NativeRuntime) {
        self.writer = writer; self.runtime = runtime; inventory = Capture(writer: writer, runtime: runtime)
    }
    func lane(_ request: Request) -> String {
        if ["hello", "permissions", "targets", "windows.list"].contains(request.op) { return "inspection:" + request.op }
        if let id = request.sessionId { return id }
        if let bundle = request.bundleId,
           let entry = sessions.first(where: { $0.value.0.target?.bundleId == bundle }) { return entry.key }
        if let bundle = request.bundleId { return "app:" + bundle }
        return sessions.count == 1 ? sessions.keys.first ?? "control" : "control"
    }
    func stop() async throws {
        for (capture, accessibility) in sessions.values { try await capture.stop(); accessibility.reset() }
    }
    func handle(_ original: Request) async {
        var request = original
        publishPermissionChanges()
        defer { publishPermissionChanges() }
        for (_, accessibility) in sessions.values { accessibility.serviceNotifications() }
        do {

                    if request.op == "hello" { reply(request, data: capabilities()); return }
                    if request.op == "permissions" { reply(request, data: permissions()); return }
                    if request.op == "permissions.request" { try requestPermission(request.permission ?? ""); reply(request, data: permissions()); return }
                    if request.op == "open.url" { reply(request, data: try await openBackgroundURL(request)); return }
                    if request.op == "open.app" { reply(request, data: try await openBackgroundApp(request)); return }
                    if request.op == "metrics" { reply(request, data: inventory.metrics); return }
                    if request.op == "targets" {
                        let content = try await inventory.content()
                        reply(request, data: ["displays": content.displays.prefix(64).map { ["displayId": $0.displayID, "width": $0.width, "height": $0.height, "bounds": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] as [String: Any] },
                            "windows": content.windows.filter(Capture.listed).prefix(2048).compactMap { window -> [String: Any]? in
                                guard let app = window.owningApplication, !app.bundleIdentifier.isEmpty else { return nil }
                                return ["windowId": window.windowID, "bundleId": app.bundleIdentifier, "title": String((window.title ?? "").prefix(1024)), "bounds": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]]
                            }]); return
                    }
                    if request.op == "start" {
                        guard sessions.count + startingSessions.count < 8, let id = request.sessionId, sessions[id] == nil, !startingSessions.contains(id), let target = request.target else { throw HelperError("Session limit or duplicate id", code: "busy") }
                        let ids = target.bundleIds ?? [target.bundleId].compactMap { $0 }
                        for (holder, pair) in sessions {
                            let existing = pair.0.target?.bundleIds ?? [pair.0.target?.bundleId].compactMap { $0 }
                            if !Set(ids).isDisjoint(with: existing) { throw HelperError("Target held by session \(holder)", code: "target_busy") }
                        }
                        guard Set(ids).isDisjoint(with: startingBundles) else { throw HelperError("Application start already pending", code: "target_busy") }
                        startingSessions.insert(id); startingBundles.formUnion(ids)
                        defer { startingSessions.remove(id); startingBundles.subtract(ids) }
                        let capture = Capture(writer: writer, runtime: runtime)
                        capture.onFailure = { error in
                            let data: [String: Any] = ["event": "session.failed", "sessionId": id, "error": ["code": "target_gone", "message": String(describing: error)]]
                            if let line = try? JSONSerialization.data(withJSONObject: data) { FileHandle.standardOutput.write(line + Data([10])) }
                        }
                        try await capture.start(request)
                        sessions[id] = (capture, Accessibility(clock: runtime.nanos, resolver: capture.resolver))
                        reply(request); return
                    }
                    let id = request.sessionId ?? (sessions.count == 1 ? sessions.keys.first : nil)
                    guard let id, let (capture, accessibility) = sessions[id] else { throw HelperError("Select a live session", code: "target_gone") }
                    request.target = request.target ?? capture.target
                    request.allowlist = request.allowlist ?? Array(capture.allowed)
                    guard request.target == capture.target else { throw HelperError("Session target differs", code: "target_gone") }
                    capture.mode = request.mode ?? "background"
                    capture.secureInputAllowed = request.secureInputAllowed == true
                    capture.humanDeviceInput = false
                    if request.op == "measure_interaction" { reply(request, data: try await capture.measureInteraction(request, accessibility: accessibility)); return }
                    if request.op == "stream.configure" {
                        guard let settings = request.settings else { throw HelperError("Stream settings required", code: "bounds") }
                        try await capture.configureStream(settings); reply(request, data: ["codec": settings.codec]); return
                    }
                    if request.op == "stream.keyframe" { capture.requestKeyframe(); reply(request); return }
                    if request.op == "stream.image" { capture.requestImage(); reply(request); return }
                    if request.op == "stop" { try await capture.stop(); accessibility.reset(); sessions.removeValue(forKey: id); reply(request); return }
                    if request.op == "capture" {
                        guard let enabled = request.enabled else { throw HelperError("Missing capture lease", code: "bounds") }
                        reply(request, data: ["afterSeq": try await capture.setCapturing(enabled)]); return
                    }
                    if request.op == "ui.tree" {
                        try withInspectionTimeout(install: { AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), $0) }) { try reply(request, encoded: accessibility.tree(request)) }; return
                    }
                    if request.op == "ui.find" {
                        try withInspectionTimeout(install: { AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), $0) }) { try reply(request, encoded: accessibility.find(request)) }; return
                    }
                    // Human device events acknowledge injection, not a settled AX tree. A drag
                    // changes the cursor and the iOS app is not in Simulator's macOS AX tree.
                    // Keep process-targeted posting and every target/permission check.
                    if request.humanDeviceInput == true,
                       capture.target?.kind == "window", capture.target?.bundleId == "com.apple.iphonesimulator",
                       ["input", "button.press"].contains(request.op) {
                        capture.mode = "background"
                        capture.humanDeviceInput = true
                        capture.synthesizedInput = false
                        if request.op == "input" {
                            guard let input = request.input else { throw HelperError("Missing input", code: "bounds") }
                            try await capture.injectHumanDevice(input)
                        } else {
                            guard let name = request.name else { throw HelperError("Missing name", code: "bounds") }
                            try await capture.pressButton(name)
                        }
                        reply(request, data: ["fallback": capture.synthesizedInput, "mode": capture.mode])
                        return
                    }
                    request.maxNodes = 64; request.maxDepth = 6
                    let window = capture.captureWindow
                    let guardState = capture.mode == "background" ? FocusGuard(targetPID: window?.owningApplication?.processID, targetWindow: window.flatMap { try? capture.resolver.resolve($0) }) : nil
                    capture.synthesizedInput = false; capture.dispatched = false; capture.deliveryConfirmed = false; capture.deliveryProbe = nil
                    accessibility.dispatched = false
                    defer { capture.deliveryProbe = nil; _ = guardState?.warning() }
                    var fallback = false
                    var actionError: Error?
                    do {
                        switch request.op {
                        case "menu.press":
                            try pressMenu(request) { capture.dispatched = true }
                            capture.deliveryConfirmed = true
                        case "button.press":
                            guard let name = request.name else { throw HelperError("Missing name", code: "bounds") }
                            try await capture.pressButton(name)
                        case "input":
                            guard let input = request.input else { throw HelperError("Missing input", code: "bounds") }
                            try await capture.injectV2(input); fallback = capture.synthesizedInput
                        case "action":
                            guard let action = request.action else { throw HelperError("Missing action", code: "bounds") }
                            try await capture.inject(action); fallback = capture.synthesizedInput
                        case "ui.act":
                            fallback = try await accessibility.act(request) { bounds, action, value in
                                try await capture.semanticFallback(bounds, action: action, value: value)
                            }
                        default: throw HelperError("Unsupported command", code: "not_supported")
                        }
                    } catch { actionError = error }
                    accessibility.invalidate()
                    // Preserve the action's reason before observing or inspecting focus.
                    if let actionError {
                        let fault = actionError as? HelperError
                        throw HelperError(String(describing: actionError), code: fault?.code ?? "internal", phase: capture.dispatched || accessibility.dispatched ? "partial" : fault?.phase ?? "rejected-before-dispatch", candidates: fault?.candidates ?? [])
                    }
                    if fallback, !capture.deliveryConfirmed, let probe = capture.deliveryProbe {
                        // Inspect only the destination; unchanged arrows/shortcuts remain unconfirmed.
                        for _ in 0..<12 {
                            if probe() { capture.deliveryConfirmed = true; break }
                            try await Task.sleep(nanoseconds: 5_000_000)
                        }
                    }
                    if capture.mode == "background", fallback, !capture.deliveryConfirmed {
                        throw HelperError("Input was dispatched to the selected window but its effect is unconfirmed. Do not retry automatically; inspect the destination or use menu.press/open.url", code: "delivery_unconfirmed", phase: "dispatched")
                    }
                    var data: [String: Any] = ["fallback": fallback, "mode": capture.mode, "phase": "dispatched"]
                    if let warning = guardState?.warning() { data["warnings"] = [warning] }
                    reply(request, data: data)

        } catch { reply(request, error: error) }
    }
}
