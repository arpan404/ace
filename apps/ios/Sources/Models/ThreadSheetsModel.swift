import Foundation
import Observation

/// The open thread's Agents, Changes and Work sheets. The bridge follows each only while it is shown;
/// rows arrive shaped, and git outcomes are correlated by request id.
@MainActor @Observable final class ThreadSheetsModel {
    struct OpenFile: Equatable { let path: String; let diff: FileDiff }
    var agents: AgentSheet?
    var changes: ChangesSummary?
    var file: OpenFile?
    var outcomes: [String: GitOutcome] = [:]
    /// The latest AI draft for the commit or PR editor.
    var draft: GitDraft?
    var work: WorkSummary?
    var branches: WorkBranches?
    /// Work writes' outcomes and stale-lock clears, by request id.
    var workResults: [String: WorkResult] = [:]
    func reset() {
        agents = nil; changes = nil; file = nil; outcomes = [:]; draft = nil
        work = nil; branches = nil; workResults = [:]
    }
}
