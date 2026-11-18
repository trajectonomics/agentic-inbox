import { describe, expect, it } from "bun:test"
import type { Env } from "../types"
import {
	attachmentDeleteErrorMessage,
	attachmentObjectKeys,
	deleteAttachmentObjects,
} from "./attachments"

const rows = [
	{ id: "a1", email_id: "e1", filename: "receipt.pdf" },
	{ id: "a2", email_id: "e1", filename: "note.txt" },
]

/**
 * A bucket that records each successful delete call and refuses only the call
 * at `refuseAt`, the way R2 answers when one request fails.
 */
function recordingBucket(refuseAt = Number.POSITIVE_INFINITY) {
	let attempts = 0
	const calls: string[][] = []
	const bucket = {
		delete: async (keys: string | string[]) => {
			const attempt = attempts++
			if (attempt === refuseAt) throw new Error("R2 unavailable")
			calls.push(Array.isArray(keys) ? keys : [keys])
		},
	} as unknown as Env["BUCKET"]
	return { bucket, calls }
}

const keysOf = (count: number) =>
	Array.from({ length: count }, (_, index) => `attachments/e1/a${index}/file.pdf`)

describe("attachment keys for a delete", () => {
	it("builds one key per Attachment row from the row's own ids and filename", () => {
		expect(attachmentObjectKeys(rows)).toEqual([
			"attachments/e1/a1/receipt.pdf",
			"attachments/e1/a2/note.txt",
		])
	})

	it("takes the Message id from the row, so a wrong id in a URL names no key", () => {
		expect(attachmentObjectKeys([{ id: "a1", email_id: "e2", filename: "x.pdf" }])).toEqual([
			"attachments/e2/a1/x.pdf",
		])
	})

	it("sanitizes a filename that carries a path separator", () => {
		expect(attachmentObjectKeys([{ id: "a1", email_id: "e1", filename: "../x.pdf" }])).toEqual([
			"attachments/e1/a1/.._x.pdf",
		])
	})

	it("builds no key for a Message with no Attachment rows", () => {
		expect(attachmentObjectKeys([])).toEqual([])
	})
})

describe("deleting Attachment objects", () => {
	it("makes no R2 call for an empty key list", async () => {
		const { bucket, calls } = recordingBucket()
		expect(await deleteAttachmentObjects(bucket, [])).toEqual({
			deletedKeys: [],
			remainingKeys: [],
		})
		expect(calls).toEqual([])
	})

	it("removes the keys and reports them as deleted", async () => {
		const { bucket, calls } = recordingBucket()
		expect(await deleteAttachmentObjects(bucket, attachmentObjectKeys(rows))).toEqual({
			deletedKeys: ["attachments/e1/a1/receipt.pdf", "attachments/e1/a2/note.txt"],
			remainingKeys: [],
		})
		expect(calls).toEqual([["attachments/e1/a1/receipt.pdf", "attachments/e1/a2/note.txt"]])
	})

	it("splits 1001 keys into the 1000 a delete call takes and the one left", async () => {
		const keys = keysOf(1001)
		const { bucket, calls } = recordingBucket()
		const result = await deleteAttachmentObjects(bucket, keys)
		expect(calls.map((call) => call.length)).toEqual([1000, 1])
		expect(result.deletedKeys).toHaveLength(1001)
		expect(result.remainingKeys).toEqual([])
	})

	it("stops at the first chunk R2 refuses and names what remains", async () => {
		const keys = keysOf(1001)
		const { bucket, calls } = recordingBucket(1)
		const result = await deleteAttachmentObjects(bucket, keys)
		expect(calls).toHaveLength(1)
		expect(result.deletedKeys).toHaveLength(1000)
		expect(result.remainingKeys).toEqual([keys[1000]])
	})

	it("removes exactly the remainder on a retry after a refusal", async () => {
		const keys = keysOf(1001)
		const refused = recordingBucket(1)
		const first = await deleteAttachmentObjects(refused.bucket, keys)
		const retry = await deleteAttachmentObjects(refused.bucket, first.remainingKeys)
		expect(retry.deletedKeys).toEqual([keys[1000]])
		expect(retry.remainingKeys).toEqual([])
	})
})

describe("the sentence a failed Attachment delete shows", () => {
	it("has one sentence for the one code", () => {
		expect(attachmentDeleteErrorMessage("attachment_delete_failed")).toBe(
			"The Attachment files could not all be removed, so the mail was not deleted",
		)
	})
})
