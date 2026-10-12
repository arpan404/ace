struct ApprovalSubmission: Equatable {
    enum Phase: Equatable { case saving, waiting }
    let requestId: String
    var phase: Phase
}
