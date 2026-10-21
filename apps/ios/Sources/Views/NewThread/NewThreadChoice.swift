import Foundation

/// The agent and model a New thread draft runs on: the draft's own pick, else what the bridge
/// suggests (`compose.start`). Shared by the sheet's composer and its model sheet.
@MainActor struct NewThreadChoice {
    let agent: ComposeAgent?
    let model: ComposeAgent.Model?
    /// The effort the first turn runs at, as the draft or the bridge's suggestion has it.
    let effort: String?

    init(compose: ComposeModel?, draft: NewThreadDraft) {
        let provider = draft.provider ?? compose?.start?.provider
        let agent = compose?.agents.first { $0.provider == provider }
        var model: ComposeAgent.Model?
        if let agent {
            let key = draft.provider == agent.provider ? draft.model : compose?.start?.model
            let account = draft.provider == agent.provider ? draft.account : compose?.start?.account
            model = agent.models.first { $0.key == key && (account == nil || $0.account == account) } ?? agent.models.first { $0.key == key }
        }
        self.agent = agent
        self.model = model
        effort = draft.effort ?? (draft.model == nil ? compose?.start?.effort : nil) ?? model?.defaultEffort
    }

    /// The fields the model sheet can change, so closing it puts them back.
    struct Snapshot {
        let provider: String?, model: String?, account: String?, effort: String?, speed: String?, access: String?
        init(_ draft: NewThreadDraft) {
            provider = draft.provider; model = draft.model; account = draft.account
            effort = draft.effort; speed = draft.speed; access = draft.access
        }
        func restore(_ draft: inout NewThreadDraft) {
            draft.provider = provider; draft.model = model; draft.account = account
            draft.effort = effort; draft.speed = speed; draft.access = access
        }
    }
}
