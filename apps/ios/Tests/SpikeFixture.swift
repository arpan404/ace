import Foundation

/// The loopback spike daemon these contracts talk to. `TEST_RUNNER_ACE_SPIKE_PORT` (seen here as
/// `ACE_SPIKE_PORT`) selects another fixture when a shared machine already holds the default.
enum SpikeFixture {
    static var port: Int {
        Int(ProcessInfo.processInfo.environment["ACE_SPIKE_PORT"] ?? "") ?? 9841
    }
}
