import Foundation
import AppKit
import Darwin

@main struct ScreenHelper {
    @MainActor static func main() async {
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--socket" else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        do {
            let capture = Capture(writer: try FrameWriter(path: CommandLine.arguments[2]))
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
                      request.version == 1, !request.id.isEmpty, request.id.count <= 64 else { exit(2) }
                do {
                    switch request.op {
                    case "permissions": reply(request.id, data: permissions())
                    case "targets":
                        let content = try await capture.content()
                        reply(request.id, data: ["displays": content.displays.prefix(64).map { ["displayId": $0.displayID, "width": $0.width, "height": $0.height, "bounds": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] as [String: Any] },
                                                 "windows": content.windows.prefix(2048).compactMap { window -> [String: Any]? in
                            guard let app = window.owningApplication, !app.bundleIdentifier.isEmpty else { return nil }
                            return ["windowId": window.windowID, "bundleId": app.bundleIdentifier, "title": String((window.title ?? "").prefix(1024)), "bounds": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]]
                        }])
                    case "start": try await capture.start(request); reply(request.id)
                    case "stop": try await capture.stop(); reply(request.id)
                    case "action":
                        guard let action = request.action else { throw HelperError("Missing action") }
                        try await capture.inject(action); reply(request.id)
                    default: throw HelperError("Unsupported command")
                    }
                } catch { reply(request.id, error: String(describing: error)) }
            }
            try await capture.stop()
        } catch { FileHandle.standardError.write(Data("screen-helper: \(error)\n".utf8)); exit(1) }
    }
}
