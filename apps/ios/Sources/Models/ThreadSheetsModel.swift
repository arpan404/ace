import Foundation
import Observation

/// The open thread's Agents and Changes sheets. The bridge follows each only while it is shown;
/// rows arrive shaped, and git outcomes are correlated by request id.
@MainActor @Observable final class ThreadSheetsModel {
    struct OpenFile: Equatable { let path: String; let diff: FileDiff }
    var agents: AgentSheet?
    var logs: LogsSheet?
    /// Logs Copy answers, by request.
    var copies: [String: String] = [:]
    var changes: ChangesSummary?
    var file: OpenFile?
    var outcomes: [String: GitOutcome] = [:]
    /// The latest AI draft for the commit or PR editor.
    var draft: GitDraft?
    func reset() { agents = nil; logs = nil; copies = [:]; changes = nil; file = nil; outcomes = [:]; draft = nil }
}
