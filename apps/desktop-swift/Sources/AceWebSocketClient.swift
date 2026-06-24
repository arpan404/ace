import Foundation

enum AceClientError: Error, LocalizedError {
    case invalidFrame
    case server(code: String, message: String)
    case eventInsteadOfResult(String)

    var errorDescription: String? {
        switch self {
        case .invalidFrame:
            "Invalid WebSocket frame"
        case let .server(code, message):
            "\(code): \(message)"
        case let .eventInsteadOfResult(topic):
            "Unexpected event response: \(topic)"
        }
    }
}

actor AceWebSocketClient {
    private let endpoint: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var socket: URLSessionWebSocketTask?
    private var pending: [String: PendingResponse] = [:]

    init(endpoint: URL) {
        self.endpoint = endpoint
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    func request<Payload: Encodable, Body: Decodable>(
        method: String,
        payload: Payload,
        response: Body.Type = Body.self
    ) async throws -> Body where Body: Sendable {
        let socket = ensureConnected()
        let request = WsClientRequest(method: method, payload: payload)
        let data = try encoder.encode(request)
        guard let text = String(data: data, encoding: .utf8) else {
            throw AceClientError.invalidFrame
        }

        return try await withCheckedThrowingContinuation { continuation in
            pending[request.requestId] = PendingResponse(
                resume: { responseData in
                    do {
                        let decoder = JSONDecoder()
                        let envelope = try decoder.decode(WsServerResponse<Body>.self, from: responseData)
                        switch envelope.payload {
                        case let .result(body):
                            continuation.resume(returning: body)
                        case let .error(code, message):
                            continuation.resume(throwing: AceClientError.server(code: code, message: message))
                        case let .event(topic):
                            continuation.resume(throwing: AceClientError.eventInsteadOfResult(topic))
                        }
                    } catch {
                        continuation.resume(throwing: error)
                    }
                },
                fail: { error in
                    continuation.resume(throwing: error)
                }
            )

            Task {
                do {
                    try await socket.send(.string(text))
                } catch {
                    self.failPendingRequest(request.requestId, error: error)
                }
            }
        }
    }

    private func ensureConnected() -> URLSessionWebSocketTask {
        if let socket {
            return socket
        }
        let socket = URLSession.shared.webSocketTask(with: endpoint)
        self.socket = socket
        socket.resume()
        Task { await receiveLoop(socket: socket) }
        return socket
    }

    private func receiveLoop(socket: URLSessionWebSocketTask) async {
        while self.socket === socket {
            do {
                let message = try await socket.receive()
                let data: Data
                switch message {
                case let .string(text):
                    data = Data(text.utf8)
                case let .data(frame):
                    data = frame
                @unknown default:
                    throw AceClientError.invalidFrame
                }

                let index = try decoder.decode(WsResponseIndex.self, from: data)
                guard let response = pending.removeValue(forKey: index.requestId) else {
                    continue
                }
                response.resume(data)
            } catch {
                self.socket = nil
                let pending = self.pending
                self.pending.removeAll()
                for response in pending.values {
                    response.fail(error)
                }
                return
            }
        }
    }

    private func failPendingRequest(_ requestId: String, error: Error) {
        pending.removeValue(forKey: requestId)?.fail(error)
    }
}

private struct PendingResponse: Sendable {
    let resume: @Sendable (Data) -> Void
    let fail: @Sendable (Error) -> Void

    init(
        resume: @escaping @Sendable (Data) -> Void,
        fail: @escaping @Sendable (Error) -> Void
    ) {
        self.resume = resume
        self.fail = fail
    }
}
