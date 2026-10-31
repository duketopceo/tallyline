#if os(iOS)
import Foundation
import Security

/// The device credential in the iOS Keychain: after-first-unlock, this device
/// only, never synced to iCloud.
///
/// The item lives in the App Group's keychain access group so the share
/// extension can file issues as this device. Builds without the group
/// (unsigned simulator runs) fall back to the app's own keychain. An item
/// saved by an older build outside the group moves into it on first read.
public final class KeychainCredentialStore: CredentialStore, @unchecked Sendable {
    private let service = "app.tallyline.ios.device-credential"
    /// One credential per install today. Multi-instance support keys this by
    /// server URL when that lands.
    private let account = "default"
    private let accessGroup: String?

    public init(accessGroup: String? = WidgetSnapshot.appGroup) {
        self.accessGroup = accessGroup
    }

    private func query(group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    private func read(group: String?) -> (OSStatus, Data?) {
        var q = query(group: group)
        q[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        return (status, item as? Data)
    }

    public func load() throws -> DeviceCredential? {
        var (status, data) = read(group: accessGroup)
        if accessGroup != nil, status == errSecItemNotFound || status == errSecMissingEntitlement {
            // No group entitlement, or an item from before the group existed.
            (status, data) = read(group: nil)
            if status == errSecSuccess, let data, let credential = decode(data) {
                try? save(credential)
                return credential
            }
        }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data else {
            throw APIClientError.transport("keychain read failed (\(status))")
        }
        return decode(data)
    }

    public func save(_ credential: DeviceCredential) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(credential)
        try clear()
        var status = add(data, group: accessGroup)
        if status == errSecMissingEntitlement, accessGroup != nil {
            status = add(data, group: nil)
        }
        guard status == errSecSuccess else {
            throw APIClientError.transport("keychain write failed (\(status))")
        }
    }

    /// Removes the item from the group and from the app's own keychain.
    public func clear() throws {
        SecItemDelete(query(group: nil) as CFDictionary)
        if let accessGroup { SecItemDelete(query(group: accessGroup) as CFDictionary) }
    }

    private func add(_ data: Data, group: String?) -> OSStatus {
        var q = query(group: group)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        q[kSecValueData as String] = data
        return SecItemAdd(q as CFDictionary, nil)
    }

    private func decode(_ data: Data) -> DeviceCredential? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(DeviceCredential.self, from: data)
    }
}
#endif
