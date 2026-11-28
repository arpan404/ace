struct ApprovalSubmission: Equatable {
    enum Phase: Equatable { case saving, waiting }
    let requestId: String
    var phase: Phase
    /// Sent from the inbox or the needs-you run (`answerNeed`): the approve haptic follows its admission.
    var fromNeeds = false
}
