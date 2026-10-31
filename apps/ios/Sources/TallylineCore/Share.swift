import Foundation

/// Turns what another app shared (a link, some text) into a triage issue.
public enum ShareComposer {
    public static let titleLimit = 120

    /// nil when there is nothing usable to file.
    public static func draft(text: String?, url: URL?, teamId: String) -> IssueCreate? {
        let lines = (text ?? "")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let firstIndex = lines.firstIndex { !$0.isEmpty }
        var title: String
        var rest: [String]
        if let firstIndex {
            title = lines[firstIndex]
            rest = Array(lines[(firstIndex + 1)...])
        } else if let url {
            title = linkTitle(url)
            rest = []
        } else {
            return nil
        }
        if title.count > titleLimit {
            rest.insert(title, at: 0)
            title = shorten(title)
        }
        var body = rest.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if let url, !(text ?? "").contains(url.absoluteString) {
            body = body.isEmpty ? url.absoluteString : body + "\n\n" + url.absoluteString
        }
        return IssueCreate(title: title, description: body.isEmpty ? nil : body, teamId: teamId, state: .triage)
    }

    /// `example.com/docs/page` for a bare link.
    static func linkTitle(_ url: URL) -> String {
        let host = url.host.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 } ?? url.absoluteString
        let path = url.path == "/" ? "" : url.path
        return shorten(host + path)
    }

    /// Cut at a word boundary and mark the cut.
    static func shorten(_ text: String) -> String {
        guard text.count > titleLimit else { return text }
        let cut = text.prefix(titleLimit - 1)
        let atSpace = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return atSpace.trimmingCharacters(in: .whitespaces) + "…"
    }
}

/// An issue the share extension could not send. The app moves it into its
/// outbox with the same id, which is also the idempotency key, so a send
/// that did reach the server is not filed twice.
public struct SharedDraft: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let workspaceSlug: String
    public let draft: IssueCreate
    public let createdAt: Date

    public init(id: String = UUID().uuidString, workspaceSlug: String, draft: IssueCreate, createdAt: Date = Date()) {
        self.id = id
        self.workspaceSlug = workspaceSlug
        self.draft = draft
        self.createdAt = createdAt
    }
}

/// One file per draft in the App Group, so the extension and the app never
/// write the same file.
public struct ShareInbox: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public static func shared(fileManager: FileManager = .default) -> ShareInbox? {
        #if canImport(Darwin)
        guard let dir = fileManager.containerURL(forSecurityApplicationGroupIdentifier: WidgetSnapshot.appGroup) else { return nil }
        return ShareInbox(directory: dir.appendingPathComponent("Tallyline/share-inbox", isDirectory: true))
        #else
        return nil
        #endif
    }

    public func add(_ item: SharedDraft) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(item).write(to: file(item.id), options: [.atomic])
    }

    /// Oldest first. Unreadable files are skipped, not deleted.
    public func pending() -> [SharedDraft] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(SharedDraft.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func remove(_ id: String) {
        try? FileManager.default.removeItem(at: file(id))
    }

    private func file(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }
}
