import Foundation

/// One workspace the person can work in, for the switcher.
public struct WorkspaceChoice: Sendable, Equatable, Identifiable {
    public let slug: String
    public let name: String
    public let role: String
    /// This phone holds a credential for it, so switching needs no pairing.
    public let isPaired: Bool
    public let isCurrent: Bool
    public var id: String { slug }
}

public enum WorkspaceSwitcher {
    /// The workspaces to offer, current first. Empty unless the person belongs
    /// to more than one live workspace: a single-workspace person sees no
    /// switcher at all. Workspaces waiting for deletion are left out.
    public static func choices(memberships: [Whoami.Membership], current: String, pairedSlugs: Set<String>) -> [WorkspaceChoice] {
        let live = memberships.filter { $0.deletedAt == nil }
        guard live.count > 1 else { return [] }
        let all = live.map { member in
            WorkspaceChoice(
                slug: member.workspaceSlug,
                name: member.workspaceName ?? member.workspaceSlug,
                role: member.role,
                isPaired: member.workspaceSlug == current || pairedSlugs.contains(member.workspaceSlug),
                isCurrent: member.workspaceSlug == current
            )
        }
        return all.filter(\.isCurrent) + all.filter { !$0.isCurrent }
    }
}

/// Credentials for the workspaces this phone is paired with but is not using
/// right now. The active credential stays in the main `CredentialStore`; a
/// switch swaps the two. A device credential is bound to one workspace on the
/// server, so each workspace needs its own.
public final class CredentialShelf: @unchecked Sendable {
    private let makeStore: @Sendable (String) -> any CredentialStore
    private let index: JSONFileStore<[String]>?
    private let lock = NSLock()
    private var slugs: Set<String>

    /// `makeStore` returns the store for one workspace slug (Keychain on
    /// device, in memory in tests). `index` remembers which slugs are shelved.
    public init(index: JSONFileStore<[String]>? = nil, makeStore: @escaping @Sendable (String) -> any CredentialStore) {
        self.makeStore = makeStore
        self.index = index
        self.slugs = Set((try? index?.read()) ?? [])
    }

    public var shelvedSlugs: Set<String> { lock.withLock { slugs } }

    public func shelve(_ credential: DeviceCredential) throws {
        try makeStore(credential.workspaceSlug).save(credential)
        lock.withLock { _ = slugs.insert(credential.workspaceSlug) }
        persist()
    }

    /// Removes and returns the credential for `slug`, if the shelf has it.
    public func take(_ slug: String) throws -> DeviceCredential? {
        let store = makeStore(slug)
        let credential = try store.load()
        try store.clear()
        lock.withLock { _ = slugs.remove(slug) }
        persist()
        return credential
    }

    /// Sign-out: nothing stays on the phone.
    public func clear() {
        for slug in shelvedSlugs { try? makeStore(slug).clear() }
        lock.withLock { slugs = [] }
        persist()
    }

    private func persist() {
        let current = lock.withLock { Array(slugs).sorted() }
        try? index?.write(current)
    }
}

/// One issue cache per workspace, so a switch never shows A's issues in B and
/// A's cache is still warm when the person switches back.
public struct IssueCacheDirectory: Sendable {
    public let directory: URL?

    /// `directory` is the Application Support base (tests pass a temp folder).
    public init(directory: URL? = nil) {
        self.directory = directory
    }

    /// File-safe name for a slug. Slugs are already lowercase words and dashes;
    /// anything else is replaced so an odd slug cannot walk out of the folder.
    static func safe(_ slug: String) -> String {
        String(slug.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }

    public func store(for workspaceSlug: String) -> JSONFileStore<IssueCacheSnapshot> {
        JSONFileStore<IssueCacheSnapshot>.standard(named: "\(Self.prefix)-\(Self.safe(workspaceSlug))", in: directory)
    }
}

extension IssueCacheDirectory {
    static let prefix = "issue-cache"

    /// Every cache file, including the pre-switcher single `issue-cache.json`.
    /// Sign-out: nothing from any workspace stays on the phone.
    public func deleteAll() {
        let base = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let folder = base.appendingPathComponent("Tallyline", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasPrefix(Self.prefix) && file.pathExtension == "json" {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// The one-file cache older builds wrote. Read once, then removed.
    public func legacyStore() -> JSONFileStore<IssueCacheSnapshot> {
        JSONFileStore<IssueCacheSnapshot>.standard(named: Self.prefix, in: directory)
    }
}

/// How this build reached the phone, for the rows only some channels get.
public enum BuildChannel: Sendable, Equatable {
    case debug
    case testFlight
    case appStore

    /// TestFlight builds carry a receipt named `sandboxReceipt`; App Store
    /// builds carry `receipt`. Pass `Bundle.main.appStoreReceiptURL`.
    public static func detect(receiptURL: URL?, isDebug: Bool) -> BuildChannel {
        if isDebug { return .debug }
        return receiptURL?.lastPathComponent == "sandboxReceipt" ? .testFlight : .appStore
    }

    public var offersFeedback: Bool { self == .testFlight }
}

/// Alternate app icons, offered only when the build declares some.
public enum AlternateIcons {
    /// Names from `CFBundleIcons` > `CFBundleAlternateIcons` in Info.plist.
    public static func declared(in info: [String: Any]?) -> [String] {
        guard let icons = info?["CFBundleIcons"] as? [String: Any],
              let alternates = icons["CFBundleAlternateIcons"] as? [String: Any] else { return [] }
        return alternates.keys.sorted()
    }
}
