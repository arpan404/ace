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
        // A busy app (a Simulator mid-rotation on a loaded machine) must not hold a command for
        // the six-second default: every Accessibility call gives up after one second.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1)
        do {
            let runtime = NativeRuntime(nanos: { DispatchTime.now().uptimeNanoseconds }, milliseconds: { Date().timeIntervalSince1970 * 1000 }, uptime: { ProcessInfo.processInfo.systemUptime }, inputAllowed: { AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() })
            let writer = try FrameWriter(path: path)
            let inventory = Capture(writer: writer, runtime: runtime)
            var sessions: [String: (Capture, Accessibility)] = [:]
            defer { for (_, accessibility) in sessions.values { accessibility.reset() } }
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
                // Service queued AX notifications only at command boundaries, with no idle timer.
                for (_, accessibility) in sessions.values { accessibility.serviceNotifications() }
                guard var request = try? JSONDecoder().decode(Request.self, from: line),
                      (request.version == 1 || request.version == 2), !request.id.isEmpty, request.id.count <= 64 else { exit(2) }
                do {
                    if request.op == "hello" { reply(request, data: capabilities()); continue }
                    if request.op == "permissions" { reply(request, data: permissions()); continue }
                    if request.op == "permissions.request" { try requestPermission(request.permission ?? ""); reply(request, data: permissions()); continue }
                    if request.op == "open.app" { reply(request, data: try await openBackgroundApp(request)); continue }
                    if request.op == "metrics" { reply(request, data: inventory.metrics); continue }
                    if request.op == "targets" {
                        let content = try await inventory.content()
                        reply(request, data: ["displays": content.displays.prefix(64).map { ["displayId": $0.displayID, "width": $0.width, "height": $0.height, "bounds": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] as [String: Any] },
                            "windows": content.windows.filter(Capture.listed).prefix(2048).compactMap { window -> [String: Any]? in
                                guard let app = window.owningApplication, !app.bundleIdentifier.isEmpty else { return nil }
                                return ["windowId": window.windowID, "bundleId": app.bundleIdentifier, "title": String((window.title ?? "").prefix(1024)), "bounds": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]]
                            }]); continue
                    }
                    if request.op == "start" {
                        guard sessions.count < 8, let id = request.sessionId, sessions[id] == nil, let target = request.target else { throw HelperError("Session limit or duplicate id", code: "busy") }
                        let ids = target.bundleIds ?? [target.bundleId].compactMap { $0 }
                        for (holder, pair) in sessions {
                            let existing = pair.0.target?.bundleIds ?? [pair.0.target?.bundleId].compactMap { $0 }
                            if !Set(ids).isDisjoint(with: existing) { throw HelperError("Target held by session \(holder)", code: "target_busy") }
                        }
                        let capture = Capture(writer: writer, runtime: runtime)
                        try await capture.start(request)
                        sessions[id] = (capture, Accessibility(clock: { DispatchTime.now().uptimeNanoseconds }))
                        reply(request); continue
                    }
                    let id = request.sessionId ?? (sessions.count == 1 ? sessions.keys.first : nil)
                    guard let id, let (capture, accessibility) = sessions[id] else { throw HelperError("Select a live session", code: "target_gone") }
                    request.target = request.target ?? capture.target
                    request.allowlist = request.allowlist ?? Array(capture.allowed)
                    guard request.target == capture.target else { throw HelperError("Session target differs", code: "target_gone") }
                    capture.mode = request.mode ?? "background"
                    capture.secureInputAllowed = request.secureInputAllowed == true
                    if request.op == "stream.configure" {
                        guard let settings = request.settings else { throw HelperError("Stream settings required", code: "bounds") }
                        try await capture.configureStream(settings); reply(request, data: ["codec": settings.codec]); continue
                    }
                    if request.op == "stream.keyframe" { capture.requestKeyframe(); reply(request); continue }
                    if request.op == "stream.image" { capture.requestImage(); reply(request); continue }
                    if request.op == "stop" { try await capture.stop(); accessibility.reset(); sessions.removeValue(forKey: id); reply(request); continue }
                    if request.op == "capture" {
                        guard let enabled = request.enabled else { throw HelperError("Missing capture lease", code: "bounds") }
                        reply(request, data: ["afterSeq": try await capture.setCapturing(enabled)]); continue
                    }
                    if request.op == "ui.tree" { try reply(request, encoded: await accessibility.settle(request)); continue }
                    if request.op == "ui.find" { _ = try await accessibility.settle(request); try reply(request, encoded: accessibility.find(request)); continue }
                    request.maxNodes = 64; request.maxDepth = 6
                    let guardState = capture.mode == "background" ? FocusGuard() : nil
                    let fingerprint = JSONEncoder(); fingerprint.outputFormatting = .sortedKeys
                    let before = try? fingerprint.encode(accessibility.tree(request))
                    capture.synthesizedInput = false
                    var fallback = false
                    var actionError: Error?
                    do {
                        switch request.op {
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
                    var snapshot: UITree?
                    do { snapshot = try await accessibility.settle(request) } catch { if actionError == nil { actionError = error } }
                    try guardState?.verify()
                    if let actionError { throw actionError }
                    let after = try snapshot.map { try fingerprint.encode($0) }
                    if capture.mode == "background", fallback, (before == nil || after == nil || before == after) {
                        throw HelperError("Posted input produced no observable UI change; foreground approval may be required", code: "foreground_required")
                    }
                    var data: [String: Any] = ["fallback": fallback, "mode": capture.mode]
                    if let snapshot { data["snapshot"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) }
                    reply(request, data: data)
                } catch { reply(request, error: error) }
            }
            for (capture, _) in sessions.values { try await capture.stop() }
        } catch { FileHandle.standardError.write(Data("screen-helper: \(error)\n".utf8)); exit(1) }
    }
}
