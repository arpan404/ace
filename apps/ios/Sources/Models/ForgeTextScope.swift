import Foundation

/// Media bytes the daemon fetched for GitHub text (`forge.media`).
struct ForgeMediaBytes: Decodable, Sendable, Equatable {
    /// `ready`, `none` (a plain link) or `unavailable`.
    let state: String
    let kind: String?
    let mimeType: String?
    let width: Double?
    let height: Double?
    let data: String?
    let reason: String?
}

/// Where GitHub text is drawn: its machine's client and project, the repository its media and
/// links belong to.
@MainActor struct ForgeRichScope {
    let client: ClientModel
    let project: String
    let repository: ForgeRepository?

    func media(_ url: String, role: String) async -> ForgeMediaBytes? {
        let request = ClientModel.on(repository, ["type": "forge.media", "project": project, "url": url, "role": role])
        return try? await client.service(request, as: ForgeMediaBytes.self)
    }
}

extension ClientModel {
    /// Tick or untick one task box, in the text the phone showed. Sent once.
    func forgeTask(project: String, number: Int, repository: ForgeRepository, on: [String: Any], offset: Int, checked: Bool) async -> ForgeReviewOutcome {
        guard canOperate else { return ForgeReviewOutcome(ok: false, message: "View only. Pair this phone with View and act to tick boxes.", uncertain: false) }
        let request: [String: Any] = ["type": "forge.task", "project": project, "number": number, "repository": repository.json,
                                      "on": on, "offset": offset, "checked": checked]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
}
