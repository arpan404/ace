import Foundation

let protocolVersion: UInt16 = 1

enum WsMethod {
    static let projectsList = "projects.list"
    static let projectsAdd = "projects.add"
    static let codexThreadsList = "codex.threads.list"
    static let codexThreadStart = "codex.thread.start"
    static let codexThreadRead = "codex.thread.read"
    static let codexTurnStart = "codex.turn.start"
}

struct WsClientRequest<Payload: Encodable>: Encodable {
    let version: UInt16
    let requestId: String
    let method: String
    let payload: Payload

    init(method: String, payload: Payload) {
        self.version = protocolVersion
        self.requestId = UUID().uuidString
        self.method = method
        self.payload = payload
    }

    enum CodingKeys: String, CodingKey {
        case version
        case requestId = "request_id"
        case method
        case payload
    }
}

struct WsServerResponse<Body: Decodable>: Decodable {
    let version: UInt16
    let requestId: String
    let payload: WsServerPayload<Body>

    enum CodingKeys: String, CodingKey {
        case version
        case requestId = "request_id"
        case payload
    }
}

struct WsResponseIndex: Decodable {
    let requestId: String

    enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
    }
}

enum WsServerPayload<Body: Decodable>: Decodable {
    case result(Body)
    case event(topic: String)
    case error(code: String, message: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case body
        case topic
        case code
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "result":
            self = .result(try container.decode(Body.self, forKey: .body))
        case "event":
            self = .event(topic: try container.decode(String.self, forKey: .topic))
        case "error":
            self = .error(
                code: try container.decode(String.self, forKey: .code),
                message: try container.decode(String.self, forKey: .message)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown WS payload type"
            )
        }
    }
}

struct EmptyPayload: Codable {}

struct ProjectAddRequest: Encodable, Sendable {
    let workspaceRoot: String
    let title: String?
    let defaultModelSelection: ModelSelection?

    enum CodingKeys: String, CodingKey {
        case workspaceRoot = "workspace_root"
        case title
        case defaultModelSelection = "default_model_selection"
    }
}

struct ThreadsListRequest: Encodable, Sendable {
    let includeArchived: Bool?
    let limit: UInt32?

    enum CodingKeys: String, CodingKey {
        case includeArchived = "include_archived"
        case limit
    }
}

struct ThreadIdRequest: Encodable, Sendable {
    let threadId: String

    enum CodingKeys: String, CodingKey {
        case threadId = "thread_id"
    }
}

struct ThreadStartRequest: Encodable, Sendable {
    let cwd: String?
    let model: String?
    let approvalPolicy: [String: String]?

    enum CodingKeys: String, CodingKey {
        case cwd
        case model
        case approvalPolicy = "approval_policy"
    }
}

struct TurnStartRequest: Encodable, Sendable {
    let threadId: String
    let prompt: String
    let model: String

    enum CodingKeys: String, CodingKey {
        case threadId = "thread_id"
        case prompt
        case model
    }
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let workspaceRoot: String

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case workspaceRoot = "workspace_root"
    }
}

struct ModelSelection: Codable, Hashable, Sendable {
    let provider: String
    let model: String
}

struct ThreadStartResponse: Decodable, Sendable {
    let threadId: String

    init(from decoder: Decoder) throws {
        let value = try AnyJSON(from: decoder).value
        guard let threadId = Self.threadId(from: value) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Thread response did not include an id"
                )
            )
        }
        self.threadId = threadId
    }

    private static func threadId(from value: Any) -> String? {
        guard let object = value as? [String: Any] else { return nil }
        return object["id"] as? String
            ?? object["thread_id"] as? String
            ?? object["threadId"] as? String
            ?? (object["thread"] as? [String: Any])?["id"] as? String
    }
}

struct ThreadListResponse: Decodable, Sendable {
    let threads: [SidebarThread]

    init(from decoder: Decoder) throws {
        let value = try AnyJSON(from: decoder).value
        let array = (value as? [String: Any])?["threads"] as? [[String: Any]]
            ?? (value as? [String: Any])?["items"] as? [[String: Any]]
            ?? value as? [[String: Any]]
            ?? []
        self.threads = array.compactMap(SidebarThread.init(json:))
    }
}

struct ThreadReadResponse: Decodable, Sendable {
    let messages: [ChatMessage]

    init(from decoder: Decoder) throws {
        let value = try AnyJSON(from: decoder).value
        let object = value as? [String: Any]
        let array = object?["messages"] as? [[String: Any]]
            ?? (object?["thread"] as? [String: Any])?["messages"] as? [[String: Any]]
            ?? object?["items"] as? [[String: Any]]
            ?? []
        self.messages = array.compactMap(ChatMessage.init(json:))
    }
}

struct AnyJSON: Decodable, @unchecked Sendable {
    let value: Any

    init(from decoder: Decoder) throws {
        if let string = try? decoder.singleValueContainer().decode(String.self) {
            value = string
        } else if let object = try? decoder.container(keyedBy: DynamicCodingKey.self) {
            var result: [String: Any] = [:]
            for key in object.allKeys {
                result[key.stringValue] = try object.decode(AnyJSON.self, forKey: key).value
            }
            value = result
        } else if var array = try? decoder.unkeyedContainer() {
            var result: [Any] = []
            while !array.isAtEnd {
                result.append(try array.decode(AnyJSON.self).value)
            }
            value = result
        } else if let bool = try? decoder.singleValueContainer().decode(Bool.self) {
            value = bool
        } else if let number = try? decoder.singleValueContainer().decode(Double.self) {
            value = number
        } else {
            value = NSNull()
        }
    }
}

struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}
