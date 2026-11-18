import { describe, expect, it } from "bun:test"
import { Folders } from "../../shared/folders"
import type { Env } from "../types"
import type { OutgoingRecorder, OutgoingThreading, SentCopy } from "./outgoing-send"
import { sendAndRecord } from "./outgoing-send"

const MAILBOX = "me@example.com"

/** An Email binding that accepts every message and reports `messageId`. */
function acceptingBinding(messageId: string | undefined) {
	const sent: unknown[] = []
	const binding = {
		send: async (message: unknown) => {
			sent.push(message)
			return { messageId }
		},
	}
	return { binding: binding as unknown as Env["EMAIL"], sends: () => sent.length }
}

/** An Email binding that refuses every message with `reason`. */
function refusingBinding(reason: string) {
	let sends = 0
	const binding = {
		send: async () => {
			sends += 1
			throw new Error(reason)
		},
	}
	return { binding: binding as unknown as Env["EMAIL"], sends: () => sends }
}

/** An R2 bucket that records the keys it is asked to write. */
function fakeBucket() {
	const keys: string[] = []
	const bucket = {
		put: async (key: string) => {
			keys.push(key)
		},
	}
	return { bucket: bucket as unknown as Env["BUCKET"], keys }
}

/** A mailbox recorder that records every call, and can fail while recording. */
function fakeRecorder(options: { rateLimit?: string; failsToRecord?: boolean } = {}) {
	const copies: { folder: string; copy: SentCopy; attachments: unknown[] }[] = []
	const marks: string[] = []
	const recorder: OutgoingRecorder = {
		checkSendRateLimit: async () => options.rateLimit ?? null,
		createEmail: async (folder, copy, attachments) => {
			if (options.failsToRecord) throw new Error("storage unavailable")
			copies.push({ folder, copy, attachments })
		},
		markThreadRead: async (threadId) => {
			marks.push(threadId)
		},
	}
	return { recorder, copies, marks }
}

/** One send over fresh fakes, so each case reads as its outcome. */
function harness(
	options: {
		messageId?: string
		from?: string
		refuse?: string
		rateLimit?: string
		failsToRecord?: boolean
	} = {},
) {
	const mail = options.refuse
		? refusingBinding(options.refuse)
		: acceptingBinding(options.messageId)
	const bucket = fakeBucket()
	const { recorder, copies, marks } = fakeRecorder(options)
	const body = {
		to: "them@example.org",
		from: options.from ?? MAILBOX,
		subject: "Hello",
		html: "<p>hi</p>",
		attachments: [
			{
				content: "aGVsbG8=",
				filename: "note.txt",
				type: "text/plain",
				disposition: "attachment" as const,
			},
		],
	}
	return {
		keys: bucket.keys,
		copies,
		marks,
		sends: mail.sends,
		result: (threading: OutgoingThreading = {}) =>
			sendAndRecord({ EMAIL: mail.binding, BUCKET: bucket.bucket }, recorder, {
				mailboxId: MAILBOX,
				body,
				threading,
			}),
	}
}

/** The stored `message-id` header entry of a recorded copy. */
function storedMessageIdHeader(copy: SentCopy): string | undefined {
	const headers: { key: string; value: string }[] = JSON.parse(copy.raw_headers)
	return headers.find((header) => header.key === "message-id")?.value
}

describe("an outgoing send", () => {
	it("records the copy after the binding accepts, with the id the binding sent", async () => {
		const h = harness({ messageId: "wire-id@example.com" })
		const result = await h.result()
		const copy = h.copies[0].copy

		expect(result.status).toBe("sent")
		expect(h.sends()).toBe(1)
		expect(h.copies).toHaveLength(1)
		expect(h.copies[0].folder).toBe(Folders.SENT)
		expect(copy.message_id).toBe("wire-id@example.com")
		expect(storedMessageIdHeader(copy)).toBe("<wire-id@example.com>")
		expect(copy.thread_id).toBe(copy.id)
		expect(h.copies[0].attachments).toHaveLength(1)
		expect(h.keys[0].startsWith(`attachments/${copy.id}/`)).toBe(true)
	})

	it("records nothing and reports the refusal when the binding rejects the message", async () => {
		const h = harness({ refuse: "mailbox suspended" })

		expect(await h.result()).toEqual({
			status: "not_sent",
			error: "Failed to send email: mailbox suspended",
		})
		expect(h.copies).toHaveLength(0)
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
		expect(h.copies[0].copy.in_reply_to).toBe("original-id")
		expect(h.copies[0].copy.email_references).toBe(JSON.stringify(["original-id"]))
	})

	it("sends nothing and records nothing when the mailbox is over its rate limit", async () => {
		const h = harness({ rateLimit: "Rate limit exceeded: max 20 emails per hour per mailbox" })

		expect(await h.result()).toEqual({
			status: "rate_limited",
			error: "Rate limit exceeded: max 20 emails per hour per mailbox",
		})
		expect(h.sends()).toBe(0)
		expect(h.copies).toHaveLength(0)
		expect(h.keys).toHaveLength(0)
	})

	it("stores a bare id when the binding reports one in angle brackets", async () => {
		const h = harness({ messageId: "<wire-id@example.com>" })

		await h.result()

		expect(h.copies[0].copy.message_id).toBe("wire-id@example.com")
	})

	it("falls back to the generated id when the binding reports none", async () => {
		const h = harness({ messageId: undefined })

		await h.result()

		expect(h.copies[0].copy.message_id).toBe(`${h.copies[0].copy.id}@example.com`)
	})

	it("still reports sent when the copy cannot be recorded after an accepted send", async () => {
		const h = harness({ messageId: "wire-id@example.com", failsToRecord: true })

		const result = await h.result()

		expect(result.status).toBe("sent")
		expect(h.sends()).toBe(1)
		expect(h.copies).toHaveLength(0)
	})

	it("refuses a sender that does not match the mailbox, sending and recording nothing", async () => {
		const h = harness({ from: "someone-else@example.com" })

		expect(await h.result()).toEqual({
			status: "invalid_sender",
			error: "From address must match the mailbox email address",
		})
		expect(h.sends()).toBe(0)
		expect(h.copies).toHaveLength(0)
	})
})
