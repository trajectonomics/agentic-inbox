import { describe, expect, it } from "bun:test"
import { Folders } from "../../shared/folders"
import { harness, storedHeader } from "./outgoing-send.fixtures"

describe("an outgoing send", () => {
	it("records the Message after the binding accepts, with the id the binding sent", async () => {
		const h = harness({ messageId: "wire-id@example.com" })
		const result = await h.result()
		const message = h.recorded[0].message

		expect(result.status).toBe("sent")
		expect(h.sends()).toBe(1)
		expect(h.recorded).toHaveLength(1)
		expect(h.recorded[0].folder).toBe(Folders.SENT)
		expect(message.message_id).toBe("wire-id@example.com")
		expect(storedHeader(message, "message-id")).toBe("<wire-id@example.com>")
		expect(storedHeader(message, "to")).toBe(message.recipient)
		expect(message.recipient).toBe("them@example.org")
		expect(message.thread_id).toBe(message.id)
		expect(h.recorded[0].attachments).toHaveLength(1)
		expect(h.keys[0].startsWith(`attachments/${message.id}/`)).toBe(true)
	})

	it("records nothing and reports the refusal when the binding rejects the message", async () => {
		const h = harness({ refuse: "mailbox suspended" })

		expect(await h.result()).toEqual({
			status: "not_sent",
			error: "Failed to send email: mailbox suspended",
		})
		expect(h.recorded).toHaveLength(0)
		expect(h.keys).toHaveLength(0)
	})

	it("leaves the thread unread when a reply is refused", async () => {
		const h = harness({ refuse: "quota exceeded" })

		await h.result({ inReplyTo: "original-id", references: ["original-id"], markThreadRead: true })

		expect(h.marks).toEqual([])
	})

	it("marks the thread read once when a reply is accepted", async () => {
		const h = harness({ messageId: "wire-id@example.com" })

		await h.result({
			inReplyTo: "original-id",
			references: ["original-id"],
			threadId: "thread-1",
			markThreadRead: true,
		})

		expect(h.marks).toEqual(["thread-1"])
		expect(h.recorded[0].message.in_reply_to).toBe("original-id")
		expect(h.recorded[0].message.email_references).toBe(JSON.stringify(["original-id"]))
	})

	it("sends nothing and records nothing when the mailbox is over its rate limit", async () => {
		const h = harness({ rateLimit: "Rate limit exceeded: max 20 emails per hour per mailbox" })

		expect(await h.result()).toEqual({
			status: "rate_limited",
			error: "Rate limit exceeded: max 20 emails per hour per mailbox",
		})
		expect(h.sends()).toBe(0)
		expect(h.recorded).toHaveLength(0)
		expect(h.keys).toHaveLength(0)
	})

	it("stores a bare id when the binding reports one in angle brackets", async () => {
		const h = harness({ messageId: "<wire-id@example.com>" })

		await h.result()

		expect(h.recorded[0].message.message_id).toBe("wire-id@example.com")
	})

	it("falls back to the generated id when the binding reports none", async () => {
		const h = harness({ messageId: undefined })

		await h.result()

		expect(h.recorded[0].message.message_id).toBe(`${h.recorded[0].message.id}@example.com`)
	})

	it("still reports sent when the Message cannot be recorded after an accepted send", async () => {
		const h = harness({ messageId: "wire-id@example.com", failsToRecord: true })

		const result = await h.result()

		expect(result).toEqual({ status: "sent" })
		expect(h.sends()).toBe(1)
		expect(h.recorded).toHaveLength(0)
	})

	it("refuses a sender that does not match the mailbox, sending and recording nothing", async () => {
		const h = harness({ from: "someone-else@example.com" })

		expect(await h.result()).toEqual({
			status: "invalid_sender",
			code: "sender_mismatch",
			error: "From address must match the mailbox email address",
		})
		expect(h.sends()).toBe(0)
		expect(h.recorded).toHaveLength(0)
	})

	it("codes an address with no domain as a different sender rule", async () => {
		const h = harness({ from: "username", mailboxId: "username" })

		expect(await h.result()).toEqual({
			status: "invalid_sender",
			code: "sender_address_invalid",
			error: "Invalid sender email address",
		})
		expect(h.sends()).toBe(0)
		expect(h.recorded).toHaveLength(0)
	})
})
