import Foundation

// S6-U2: push on the phone. The flow (docs/push.md):
//   1. read the server's push config (relay URL and server key)
//   2. trade the Apple device token for a sealed handle at the relay
//   3. give only the handle to the server
// The server never sees the Apple token and the relay never sees work data.
// This file is the Foundation half, so it builds and tests on Linux; the
// UIKit and UserNotifications half lives in the app target.

/// The four content-free kinds the relay can send. Raw values match the API.
public enum PushKind: String, Codable, Sendable, CaseIterable, Identifiable {
    case assigned
    case mention
    case reviewPending = "review_pending"
    case dispatchFailed = "dispatch_failed"

    public var id: String { rawValue }

    /// Label for the Settings toggle.
    public var settingsLabel: String {
        switch self {
        case .assigned: "Assigned to me"
        case .mention: "Mentions"
        case .reviewPending: "Reviews waiting"
        case .dispatchFailed: "Agent runs that need attention"
        }
    }

    /// Where a tap on this kind should land.
    public var destination: PushDestination {
        switch self {
        case .assigned, .mention: .myIssues
        case .reviewPending: .review
        case .dispatchFailed: .myIssues
        }
    }

    /// The kind carried by a delivered notification: the relay puts it in
    /// `k` and in `aps.category`.
    public static func from(userInfo: [AnyHashable: Any]) -> PushKind? {
        if let k = userInfo["k"] as? String, let kind = PushKind(rawValue: k) { return kind }
        if let aps = userInfo["aps"] as? [String: Any], let c = aps["category"] as? String { return PushKind(rawValue: c) }
        return nil
    }
}

public enum PushDestination: String, Sendable {
    case myIssues
    case review
}

public enum PushEnvironment: String, Codable, Sendable {
    case sandbox
    case production
}

/// `GET /v1/workspaces/:ws/push/config`
public struct PushConfig: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public let relayUrl: URL?
    public let serverKey: String?

    public init(enabled: Bool, relayUrl: URL?, serverKey: String?) {
        self.enabled = enabled
        self.relayUrl = relayUrl
        self.serverKey = serverKey
    }
}

/// `GET`/`PUT /v1/workspaces/:ws/push/preferences`. Quiet hours are minutes
/// after midnight in `tz` and may wrap midnight; set all three or none.
public struct PushPreferences: Codable, Sendable, Equatable {
    public var disabledKinds: [String]
    public var quietStart: Int?
    public var quietEnd: Int?
    public var tz: String?

    public init(disabledKinds: [String] = [], quietStart: Int? = nil, quietEnd: Int? = nil, tz: String? = nil) {
        self.disabledKinds = disabledKinds
        self.quietStart = quietStart
        self.quietEnd = quietEnd
        self.tz = tz
    }

    // the API wants every key present, with null for "not set"
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(disabledKinds, forKey: .disabledKinds)
        try c.encode(quietStart, forKey: .quietStart)
        try c.encode(quietEnd, forKey: .quietEnd)
        try c.encode(tz, forKey: .tz)
    }

    public func isEnabled(_ kind: PushKind) -> Bool { !disabledKinds.contains(kind.rawValue) }

    public mutating func set(_ kind: PushKind, enabled: Bool) {
        disabledKinds.removeAll { $0 == kind.rawValue }
        if !enabled { disabledKinds.append(kind.rawValue) }
        disabledKinds.sort()
    }

    public var hasQuietHours: Bool { quietStart != nil && quietEnd != nil }

    /// Turn quiet hours on (in the given zone) or off. On keeps any existing
    /// window, defaulting to 22:00 to 07:00.
    public mutating func setQuietHours(_ on: Bool, timeZone: TimeZone = .current) {
        if on {
            quietStart = quietStart ?? 22 * 60
            quietEnd = quietEnd ?? 7 * 60
            tz = timeZone.identifier
        } else {
            quietStart = nil
            quietEnd = nil
            tz = nil
        }
    }

    /// Minutes after midnight for an hour and minute, clamped to the API's range.
    public static func minutes(hour: Int, minute: Int) -> Int {
        min(max(hour * 60 + minute, 0), 1439)
    }
}

/// Apple hands the app its device token as raw bytes; the relay wants hex.
public enum DeviceToken {
    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

/// The calls registration needs, so the order and the "push off" paths can be
/// tested without a network.
public protocol PushAPI: Sendable {
    func pushConfig() async throws -> PushConfig
    func relayHandle(relayURL: URL, tokenHex: String, environment: PushEnvironment, serverKey: String) async throws -> String
    func setDeviceHandle(_ handle: String, environment: PushEnvironment) async throws
    func clearDeviceHandle() async throws
}

public enum PushRegistrationResult: Equatable, Sendable {
    /// The server has no relay configured; nothing was sent anywhere.
    case serverPushOff
    /// The server holds this phone's handle and will ping it.
    case registered
}

public enum PushRegistrar {
    /// Register this phone for push. Safe to call on every launch: the relay
    /// mints a fresh handle and the server replaces the old one, which also
    /// recovers from a rotated server key (docs/push.md, Server setup).
    public static func register(token: Data, environment: PushEnvironment, api: any PushAPI) async throws -> PushRegistrationResult {
        let config = try await api.pushConfig()
        guard config.enabled, let relay = config.relayUrl, let serverKey = config.serverKey, !serverKey.isEmpty else {
            return .serverPushOff
        }
        let handle = try await api.relayHandle(relayURL: relay, tokenHex: DeviceToken.hex(token), environment: environment, serverKey: serverKey)
        try await api.setDeviceHandle(handle, environment: environment)
        return .registered
    }
}

/// The live `PushAPI`: the server through the paired device credential, the
/// relay with no credential at all.
public struct LivePushAPI: PushAPI {
    public let client: APIClient
    public let workspaceSlug: String

    public init(client: APIClient, workspaceSlug: String) {
        self.client = client
        self.workspaceSlug = workspaceSlug
    }

    private var ws: String { "/v1/workspaces/\(workspaceSlug)" }

    public func pushConfig() async throws -> PushConfig {
        try await client.send(method: "GET", path: "\(ws)/push/config")
    }

    public func relayHandle(relayURL: URL, tokenHex: String, environment: PushEnvironment, serverKey: String) async throws -> String {
        struct Body: Encodable { let token: String; let environment: PushEnvironment; let serverKey: String }
        struct Out: Decodable { let handle: String }
        // never send the server credential to the relay
        let relay = APIClient(baseURL: relayURL)
        let out: Out = try await relay.send(
            method: "POST",
            path: "/v1/handles",
            body: Body(token: tokenHex, environment: environment, serverKey: serverKey),
            authorized: false
        )
        return out.handle
    }

    public func setDeviceHandle(_ handle: String, environment: PushEnvironment) async throws {
        struct Body: Encodable { let handle: String; let environment: PushEnvironment }
        struct Out: Decodable {}
        let _: Out = try await client.send(method: "PUT", path: "\(ws)/devices/current/push", body: Body(handle: handle, environment: environment))
    }

    public func clearDeviceHandle() async throws {
        struct Out: Decodable {}
        let _: Out = try await client.send(method: "DELETE", path: "\(ws)/devices/current/push")
    }

    public func preferences() async throws -> PushPreferences {
        try await client.send(method: "GET", path: "\(ws)/push/preferences")
    }

    public func savePreferences(_ prefs: PushPreferences) async throws -> PushPreferences {
        try await client.send(method: "PUT", path: "\(ws)/push/preferences", body: prefs)
    }
}
