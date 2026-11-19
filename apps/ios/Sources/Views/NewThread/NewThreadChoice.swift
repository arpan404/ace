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
        // A saved effort belongs to the saved model: when the draft resolves to another one
        // (another provider, or a catalog that changed), start from the new model's default
        // instead of carrying stale thinking over.
        let listed: String?
        if let id = draft.effort, draft.model == model?.key,
           model?.efforts.contains(where: { $0.id == id }) == true {
            listed = id
        } else if draft.model == nil, let suggestion = compose?.start?.effort,
                  model?.efforts.contains(where: { $0.id == suggestion }) == true {
            listed = suggestion
        } else {
            listed = nil
        }
        effort = listed ?? model?.defaultEffort
    }
}
