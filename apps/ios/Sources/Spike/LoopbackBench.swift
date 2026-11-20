import Foundation
import JavaScriptCore
import QuartzCore
import SwiftUI

/// `--loopback-bench` (fixture builds only): how fast bytes move between the phone's loopback
/// sockets and the machine tunnel through JavaScriptCore (ADR 0194). The bridge runs the real
/// listeners, tunnel and stream mux against an in-memory machine; this fetches through the port
/// as a page would: one 5 MB bundle, then 300 small modules six at a time. Prints each result as
/// `[loopback-bench]` lines, so a device launched with `--console` shows them.
enum LoopbackBench {
    static var enabled: Bool {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--loopback-bench")
        #else
        false
        #endif
    }
    static let port = 47_811
    static let bundleBytes = 5 * 1024 * 1024
    static let modules = 300
    static let moduleBytes = 2 * 1024
}

struct LoopbackBenchView: View {
    @State private var lines: [String] = ["Starting…"]
    var body: some View {
        ScrollView {
            Text(lines.joined(separator: "\n"))
                .font(.system(.footnote, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .accessibilityIdentifier("loopback.bench")
        }
        .task { await run() }
    }

    private func say(_ line: String) {
        print("[loopback-bench] \(line)")
        lines.append(line)
    }

    private func run() async {
        let runtime = ClientRuntime.warm()
        let answer: String = await withCheckedContinuation { continuation in
            runtime.execute { context in
                let once = OnceAnswer(continuation)
                let done: @convention(block) (String) -> Void = { once.resume($0) }
                context.setObject(done, forKeyedSubscript: "aceBenchDone" as NSString)
                context.objectForKeyedSubscript("aceLoopbackBench")?.call(withArguments: [LoopbackBench.port])
            }
        }
        lines = []
        say("listen \(answer)")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration)
        let base = "http://127.0.0.1:\(LoopbackBench.port)/bytes/"
        for round in 1...3 {
            do {
                let began = CACurrentMediaTime()
                let (data, _) = try await session.data(from: URL(string: base + "\(LoopbackBench.bundleBytes)")!)
                let seconds = CACurrentMediaTime() - began
                let rate = Double(data.count) / seconds / 1_048_576
                say(String(format: "round %d bundle %d bytes %.0f ms %.1f MiB/s", round, data.count, seconds * 1000, rate))
            } catch { say("round \(round) bundle failed: \(error.localizedDescription)") }
            do {
                let began = CACurrentMediaTime()
                let count = try await withThrowingTaskGroup(of: Int.self) { group in
                    for index in 0..<LoopbackBench.modules {
                        group.addTask {
                            let url = URL(string: base + "\(LoopbackBench.moduleBytes)?m=\(round)-\(index)")!
                            return try await session.data(from: url).0.count
                        }
                    }
                    var total = 0
                    for try await bytes in group { total += bytes }
                    return total
                }
                let seconds = CACurrentMediaTime() - began
                say(String(format: "round %d modules %d (%d bytes) %.0f ms, %.1f ms each", round, LoopbackBench.modules, count,
                           seconds * 1000, seconds * 1000 / Double(LoopbackBench.modules)))
            } catch { say("round \(round) modules failed: \(error.localizedDescription)") }
        }
        // The other loopback spellings land on the same listeners.
        for host in ["localhost", "[::1]", "app.localhost"] {
            do {
                let (data, _) = try await session.data(from: URL(string: "http://\(host):\(LoopbackBench.port)/bytes/1024")!)
                say("\(host) \(data.count) bytes")
            } catch { say("\(host) failed: \(error.localizedDescription)") }
        }
        do {
            let (data, _) = try await session.data(from: URL(string: "http://app.localhost/bytes/1024")!)
            say("app.localhost on port 80 \(data.count) bytes")
        } catch { say("app.localhost on port 80 failed: \(error.localizedDescription)") }
        say("done")
        runtime.stop()
    }
}

/// Resumes a continuation once, whatever the script calls back.
private final class OnceAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String, Never>?
    init(_ continuation: CheckedContinuation<String, Never>) { self.continuation = continuation }
    func resume(_ value: String) {
        let pending = lock.withLock { () -> CheckedContinuation<String, Never>? in
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(returning: value)
    }
}
