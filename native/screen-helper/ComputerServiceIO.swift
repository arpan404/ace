import AppKit
import ApplicationServices

extension ComputerService {
    /// Starts the engine: sets AX timeouts, heals a clipboard a crashed helper left replaced,
    /// watches for Esc, restores state on SIGTERM/SIGINT/stdin EOF, then reads requests.
    static func run() -> Never {
        let service = ComputerService()
        // Accessory: no Dock icon or app switcher entry, but it may show the agent marker.
        NSApplication.shared.setActivationPolicy(.accessory)
        // Every AX call from this process gives up after this long, so a hung app can't hang us.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), cuAXTimeout)
        CUClipboard.recoverLeftovers()
        let escape = CUEscapeWatcher(signal: service.stop)
        if !escape.start() { FileHandle.standardError.write(Data("ace-screen-helper: Esc-to-stop is unavailable (event tap refused)\n".utf8)) }
        service.handleTerminationSignals()
        let cancellations = service.cancellations
        Thread.detachNewThread {
            var framer = CULineFramer()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(STDIN_FILENO, &buffer, buffer.count)
                if count <= 0 { break }
                for framed in framer.feed(buffer.prefix(count)) {
                    switch cuParseRequestLine(framed) {
                    case .blank: continue
                    case .invalid(let id, let message):
                        CUOutput.shared.send(["id": id, "ok": false, "error": ["code": "bad_request", "message": message]])
                    case .request(let id, let body) where body.string("op") == "cancel":
                        // Answered here, outside the serial queue, so it lands while work runs.
                        CUOutput.shared.reply(id, result: ["cancelled": cancellations.cancel(body.string("target") ?? "")])
                    case .request(let id, let body):
                        cancellations.register(id)
                        nonisolated(unsafe) let request = body
                        DispatchQueue.main.async { MainActor.assumeIsolated { service.enqueue(id: id, request: request) } }
                    }
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { () -> Void in service.shutdown(0) } }
        }
        withExtendedLifetime(escape) { RunLoop.main.run() }
        exit(0)
    }

    private func handleTerminationSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { () -> Void in self.shutdown(128 + number) } }
            source.resume()
            cuSignalSources.append(source)
        }
    }
}

/// Signal sources live for the whole process.
nonisolated(unsafe) private var cuSignalSources: [DispatchSourceSignal] = []
