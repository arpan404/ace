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
}
