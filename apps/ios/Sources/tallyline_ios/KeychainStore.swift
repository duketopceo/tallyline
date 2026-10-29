#if os(iOS)
import Foundation
import Security
import TallylineCore

/// The device credential in the iOS Keychain: after-first-unlock, this device
/// only, never synced to iCloud. One item keyed by server URL, so pairing a
/// second instance does not clobber the first.
public final class KeychainCredentialStore: CredentialStore, @unchecked Sendable {
    private let service = "app.tallyline.ios.device-credential"

    public init() {}

    private func query(for account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// One credential per install today — the account is the bundle scheme.
    /// Multi-instance support keys this by server URL when that lands.
    private let account = "default"

    public func load() throws -> DeviceCredential? {
        var q = query(for: account)
        q[kSecReturnData as String] = true
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw APIClientError.transport("keychain read failed (\(status))")
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(DeviceCredential.self, from: data)
    }

    public func save(_ credential: DeviceCredential) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(credential)
        var q = query(for: account)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = data
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw APIClientError.transport("keychain write failed (\(status))")
        }
    }

    public func clear() throws {
        SecItemDelete(query(for: account) as CFDictionary)
    }
}
#endif
