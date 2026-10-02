import Foundation
import AppKit
import Darwin

@main struct ScreenHelper {
    @MainActor static func main() async {
        guard CommandLine.arguments.count == 3, ["--socket", "--endpoint"].contains(CommandLine.arguments[1]) else { exit(2) }
        let argument = CommandLine.arguments[2]
        guard CommandLine.arguments[1] == "--socket" || argument.hasPrefix("unix:/") else { exit(2) }
        let path = CommandLine.arguments[1] == "--socket" ? argument : String(argument.dropFirst(5))
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        do {
            let capture = Capture(writer: try FrameWriter(path: path))
            let accessibility = Accessibility(clock: { DispatchTime.now().uptimeNanoseconds })
            defer { accessibility.reset() }
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
                accessibility.serviceNotifications()
                guard let request = try? JSONDecoder().decode(Request.self, from: line),
                      (request.version == 1 || request.version == 2), !request.id.isEmpty, request.id.count <= 64 else { exit(2) }
                do {
                    switch request.op {
                    case "metrics": reply(request, data: capture.metrics)
                    case "hello": reply(request, data: capabilities())
                    case "permissions": reply(request, data: permissions())
                    case "targets":
                        let content = try await capture.content()
                        reply(request, data: ["displays": content.displays.prefix(64).map { ["displayId": $0.displayID, "width": $0.width, "height": $0.height, "bounds": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] as [String: Any] },
                                                 "windows": content.windows.prefix(2048).compactMap { window -> [String: Any]? in
                            guard let app = window.owningApplication, !app.bundleIdentifier.isEmpty else { return nil }
                            return ["windowId": window.windowID, "bundleId": app.bundleIdentifier, "title": String((window.title ?? "").prefix(1024)), "bounds": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]]
                        }])
                    case "start": try await capture.start(request); reply(request)
                    case "stop": try await capture.stop(); accessibility.reset(); reply(request)
                    case "capture":
                        guard request.version == 2, let enabled = request.enabled else { throw HelperError("Unsupported capture lease", code: "not_supported") }
                        let sequence = try await capture.setCapturing(enabled); reply(request, data: ["afterSeq": sequence])
                    case "input":
                        guard request.version == 2, let input = request.input else { throw HelperError("Missing v2 input", code: "bounds") }
                        try await capture.injectV2(input); reply(request)
                    case "ui.tree": try reply(request, encoded: accessibility.tree(request))
                    case "ui.find": try reply(request, encoded: accessibility.find(request))
                    case "ui.act":
                        let fallback = try await accessibility.act(request) { bounds, action, value in
                            guard capture.target == request.target else { throw HelperError("Select the approved target before synthesized fallback", code: "target_gone") }
                            try await capture.semanticFallback(bounds, action: action, value: value)
                        }
                        reply(request, data: ["fallback": fallback])
                    case "action":
                        guard let action = request.action else { throw HelperError("Missing action") }
                        try await capture.inject(action); reply(request)
                    default: throw HelperError("Unsupported command", code: "not_supported")
                    }
                } catch { reply(request, error: error) }
            }
            try await capture.stop()
        } catch { FileHandle.standardError.write(Data("screen-helper: \(error)\n".utf8)); exit(1) }
    }
}
