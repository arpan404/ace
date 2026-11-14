import Foundation

/// The loopback spike daemon these contracts talk to. `TEST_RUNNER_ACE_IOS_SPIKE_PORT` (seen here as
/// `ACE_IOS_SPIKE_PORT`) selects another fixture when a shared machine already holds the default.
enum SpikeFixture {
    static var port: Int {
        Int(ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "") ?? 9841
    }
    /// A new thread waiting on the person (`approval`, `question`, `plan`, `form`, `stop`), seeded
    /// for one test, so answering it never changes what another test finds, in any order.
    static func fresh(_ scenario: String) async throws -> String {
        guard let url = URL(string: "http://127.0.0.1:\(port)/review/fresh") else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["scenario": scenario])
        let (data, _) = try await URLSession.shared.data(for: request)
        struct Fresh: Decodable { let threadId: String }
        return try JSONDecoder().decode(Fresh.self, from: data).threadId
    }
    /// `work`'s answer, or `SpikeTimeout` after `seconds`. A model action that waits on the bridge
    /// (admission, receipt) has no deadline of its own; once the fixture's socket drops, it never
    /// answers and the test would hold the run until the runner's own limit. `work` keeps running.
    @MainActor static func within<T: Sendable>(_ label: String, seconds: Int = 25, _ work: @escaping @MainActor @Sendable () async -> T) async throws -> T {
        let (answers, answer) = AsyncStream<Result<T, any Error>>.makeStream()
        Task { @MainActor in answer.yield(.success(await work())) }
        let timer = Task {
            try await Task.sleep(for: .seconds(seconds))
            answer.yield(.failure(SpikeTimeout(label: label)))
        }
        defer { timer.cancel(); answer.finish() }
        for await result in answers { return try result.get() }
        throw CancellationError()
    }
}

/// A fixture wait that ran out of time, named by what it waited for.
struct SpikeTimeout: Error, CustomStringConvertible {
    let label: String
    var description: String { "timed out: \(label)" }
}
