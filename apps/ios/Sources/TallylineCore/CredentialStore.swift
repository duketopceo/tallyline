import Foundation

/// What a session needs to work: the device credential, its expiry, and the
/// workspace it is bound to. Serialized into the credential store as JSON.
public struct DeviceCredential: Codable, Sendable {
    public var token: String
    public var expiresAt: Date
    public var deviceId: String
    public var userId: String
    public var workspaceSlug: String
    public var workspaceName: String
    public var serverURL: URL

    public init(token: String, expiresAt: Date, deviceId: String, userId: String, workspaceSlug: String, workspaceName: String, serverURL: URL) {
        self.token = token
        self.expiresAt = expiresAt
        self.deviceId = deviceId
        self.userId = userId
        self.workspaceSlug = workspaceSlug
        self.workspaceName = workspaceName
        self.serverURL = serverURL
    }

    /// Refresh a little early — a credential that expires inside this window is
    /// treated as already needing rotation.
    public func needsRotation(within leeway: TimeInterval = 86_400) -> Bool {
        expiresAt.timeIntervalSinceNow < leeway
    }
}

/// Where the credential lives. The app supplies the Keychain store; tests and
/// previews use the in-memory one.
public protocol CredentialStore: Sendable {
    func load() throws -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func clear() throws
}

public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private var credential: DeviceCredential?
    public init() {}
    public func load() throws -> DeviceCredential? { credential }
    public func save(_ credential: DeviceCredential) throws { self.credential = credential }
    public func clear() throws { credential = nil }
}
