import XCTest
@testable import TallylineCore

final class PushKindTests: XCTestCase {
    func testRawValuesMatchTheAPI() {
        XCTAssertEqual(PushKind.allCases.map(\.rawValue), ["assigned", "mention", "review_pending", "dispatch_failed"])
    }

    func testKindComesFromTheRelayPayload() {
        XCTAssertEqual(PushKind.from(userInfo: ["k": "review_pending"]), .reviewPending)
        XCTAssertEqual(PushKind.from(userInfo: ["aps": ["category": "mention"]]), .mention)
        XCTAssertNil(PushKind.from(userInfo: ["k": "something_else"]))
        XCTAssertEqual(PushKind.reviewPending.destination, .review)
        XCTAssertEqual(PushKind.assigned.destination, .myIssues)
    }

    func testDeviceTokenIsLowercaseHex() {
        XCTAssertEqual(DeviceToken.hex(Data([0x00, 0xAB, 0x10, 0xff])), "00ab10ff")
    }
}

final class PushPreferencesTests: XCTestCase {
    func testEncodesNullsForUnsetFields() throws {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(PushPreferences())) as? [String: Any]
        XCTAssertEqual(Set(json?.keys ?? [:].keys), ["disabledKinds", "quietStart", "quietEnd", "tz"])
        XCTAssertTrue(json?["quietStart"] is NSNull)
        XCTAssertTrue(json?["tz"] is NSNull)
    }

    func testDecodesTheAPIShape() throws {
        let raw = #"{"disabledKinds":["assigned"],"quietStart":1320,"quietEnd":420,"tz":"America/Denver"}"#
        let p = try JSONDecoder().decode(PushPreferences.self, from: Data(raw.utf8))
        XCTAssertFalse(p.isEnabled(.assigned))
        XCTAssertTrue(p.isEnabled(.mention))
        XCTAssertTrue(p.hasQuietHours)
    }

    func testToggleKindsAndQuietHours() {
        var p = PushPreferences()
        p.set(.mention, enabled: false)
        p.set(.assigned, enabled: false)
        p.set(.mention, enabled: false)
        XCTAssertEqual(p.disabledKinds, ["assigned", "mention"])
        p.set(.assigned, enabled: true)
        XCTAssertEqual(p.disabledKinds, ["mention"])

        p.setQuietHours(true, timeZone: TimeZone(identifier: "America/Denver")!)
        XCTAssertEqual(p.quietStart, 1320)
        XCTAssertEqual(p.quietEnd, 420)
        XCTAssertEqual(p.tz, "America/Denver")
        p.setQuietHours(false)
        XCTAssertFalse(p.hasQuietHours)
        XCTAssertNil(p.tz)
        XCTAssertEqual(PushPreferences.minutes(hour: 23, minute: 59), 1439)
        XCTAssertEqual(PushPreferences.minutes(hour: 30, minute: 0), 1439)
    }
}

private actor CallLog {
    var calls: [String] = []
    func add(_ c: String) { calls.append(c) }
}

private struct FakePushAPI: PushAPI {
    let config: PushConfig
    let log: CallLog

    func pushConfig() async throws -> PushConfig {
        await log.add("config")
        return config
    }

    func relayHandle(relayURL: URL, tokenHex: String, environment: PushEnvironment, serverKey: String) async throws -> String {
        await log.add("relay \(relayURL.host ?? "") \(tokenHex) \(environment.rawValue) \(serverKey)")
        return "h1.sealed"
    }

    func setDeviceHandle(_ handle: String, environment: PushEnvironment) async throws {
        await log.add("server \(handle) \(environment.rawValue)")
    }

    func clearDeviceHandle() async throws {
        await log.add("clear")
    }
}

final class PushRegistrarTests: XCTestCase {
    func testRegistersAtTheRelayThenHandsOnlyTheHandleToTheServer() async throws {
        let log = CallLog()
        let api = FakePushAPI(config: PushConfig(enabled: true, relayUrl: URL(string: "https://relay.example.com"), serverKey: "srvkey"), log: log)
        let result = try await PushRegistrar.register(token: Data([0xde, 0xad]), environment: .sandbox, api: api)
        XCTAssertEqual(result, .registered)
        let calls = await log.calls
        XCTAssertEqual(calls, ["config", "relay relay.example.com dead sandbox srvkey", "server h1.sealed sandbox"])
    }

    func testServerWithoutARelaySendsNothing() async throws {
        let log = CallLog()
        let api = FakePushAPI(config: PushConfig(enabled: false, relayUrl: nil, serverKey: nil), log: log)
        let result = try await PushRegistrar.register(token: Data([0x01]), environment: .production, api: api)
        XCTAssertEqual(result, .serverPushOff)
        let calls = await log.calls
        XCTAssertEqual(calls, ["config"])
    }

    func testConfigDecodesTheAPIShape() throws {
        let raw = #"{"enabled":true,"relayUrl":"https://relay.example.com","serverKey":"abc","kinds":["assigned"]}"#
        let c = try JSONDecoder().decode(PushConfig.self, from: Data(raw.utf8))
        XCTAssertEqual(c, PushConfig(enabled: true, relayUrl: URL(string: "https://relay.example.com"), serverKey: "abc"))
        let off = try JSONDecoder().decode(PushConfig.self, from: Data(#"{"enabled":false,"relayUrl":null,"serverKey":null}"#.utf8))
        XCTAssertFalse(off.enabled)
    }
}
