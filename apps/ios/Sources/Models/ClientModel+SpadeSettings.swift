import Foundation

/// Settings › Spade and New bot, through the bridge (`bridge/spade-settings.ts`,
/// `bridge/spade-new-bot.ts`). A key is handed over once and never kept on the phone.
extension ClientModel {
    private func spadeSettings(_ payload: [String: Any], failing title: String) async -> SpadeSettings.Answer {
        do { return try await service(payload, as: SpadeSettings.Answer.self, timeout: .seconds(40)) }
        catch is CancellationError { return .failed("", nil) }
        catch { return .failed(title, error.localizedDescription) }
    }
    func spadeSettingsRead(_ page: SpadeSettings.Page) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.read", "page": page.rawValue], failing: "Couldn't read Spade's settings")
    }
    func spadeSettingsRun(_ on: Bool) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.run", "on": on], failing: on ? "Couldn't turn on Spade" : "Couldn't turn off Spade")
    }
    /// `model` nil goes back to the setting's empty choice.
    func spadeSettingsModel(_ role: String, model: String?) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.model", "role": role, "model": model.map { $0 as Any } ?? NSNull()],
                            failing: "Couldn't change the model")
    }
    /// An endpoint's key to keep in the machine's keychain, or nil to remove it.
    func spadeSettingsKey(_ endpoint: String, key: String?) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.key", "endpoint": endpoint, "key": key.map { $0 as Any } ?? NSNull()],
                            failing: key == nil ? "Couldn't remove the key" : "Couldn't keep the key")
    }
    func spadeSettingsAdd(preset: String) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.endpoint.add", "preset": preset], failing: "Couldn't add it")
    }
    func spadeSettingsRemove(endpoint: String) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.endpoint.remove", "endpoint": endpoint], failing: "Couldn't remove it")
    }
    func spadeSettingsSearxng(_ url: String?) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.searxng", "url": url.map { $0 as Any } ?? NSNull()],
                            failing: "Couldn't save the address")
    }
    func spadeSettingsBrave(key: String?) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.brave", "key": key.map { $0 as Any } ?? NSNull()],
                            failing: key == nil ? "Couldn't remove the key" : "Couldn't keep the key")
    }
    func spadeSettingsDisconnect(_ connector: String) async -> SpadeSettings.Answer {
        await spadeSettings(["type": "spade.settings.disconnect", "connector": connector], failing: "Couldn't disconnect it")
    }

    private func spadeNewBot(_ payload: [String: Any], failing title: String) async -> SpadeNewBotAnswer {
        do { return try await service(payload, as: SpadeNewBotAnswer.self, timeout: .seconds(70)) }
        catch is CancellationError { return .failed("", nil) }
        catch { return .failed(title, error.localizedDescription) }
    }
    func spadeNewBotRead() async -> SpadeNewBotAnswer {
        await spadeNewBot(["type": "spade.newbot.read"], failing: "Couldn't read New bot")
    }
    /// A bot from `text`, or from a template with `text` as its first job.
    func spadeNewBotCreate(text: String, template: String?, model: String?) async -> SpadeNewBotAnswer {
        var payload: [String: Any] = ["type": "spade.newbot.create", "text": text, "timeZone": TimeZone.current.identifier]
        if let template { payload["template"] = template }
        if let model, !model.isEmpty { payload["model"] = model }
        return await spadeNewBot(payload, failing: "Couldn't make the bot")
    }
}
