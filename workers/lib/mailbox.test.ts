import { describe, expect, it } from "bun:test"
import { normalizeMailboxId } from "./mailbox"

describe("the one mailbox-id normalization", () => {
	it("lowercases an address so it matches the listing object and DO id", () => {
		expect(normalizeMailboxId("Me@Example.COM")).toBe("me@example.com")
	})

	it("leaves an already-normalized address unchanged", () => {
		expect(normalizeMailboxId("me@example.com")).toBe("me@example.com")
	})

	it("does not decode again, because Hono already decoded the path param", () => {
		expect(normalizeMailboxId("me%40Example.com")).toBe("me%40example.com")
	})
})
