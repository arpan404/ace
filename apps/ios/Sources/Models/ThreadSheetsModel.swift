import Foundation
import Observation

/// The open thread's Agents and Changes sheets. The bridge follows each only while it is shown;
/// rows arrive shaped, and git outcomes are correlated by request id.
@MainActor @Observable final class ThreadSheetsModel {
    struct OpenFile: Equatable { let path: String; let diff: FileDiff }
    var agents: AgentSheet?
    var changes: ChangesSummary?
    var file: OpenFile?
    var outcomes: [String: GitOutcome] = [:]
    func reset() { agents = nil; changes = nil; file = nil; outcomes = [:] }
}
