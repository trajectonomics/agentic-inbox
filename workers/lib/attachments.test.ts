import { describe, expect, it } from "bun:test"
import type { Env } from "../types"
import {
	attachmentBodyFor,
	attachmentObjectKey,
	attachmentReadErrorMessage,
	isTextMimeType,
	MAX_INLINE_ATTACHMENT_BYTES,
	MAX_INLINE_ATTACHMENT_CHARS,
	readAttachmentBody,
	sanitizeAttachmentFilename,
} from "./attachments"

const record = { id: "a1", email_id: "e1", filename: "note.txt", mimetype: "text/plain", size: 5 }

/** A bucket that answers only the keys it holds and records what was read. */
function fakeBucket(held: Map<string, Uint8Array>, reads: string[] = []) {
	return {
		get: async (key: string) => {
			reads.push(key)
			const bytes = held.get(key)
			if (!bytes) return null
			return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }
		},
	} as unknown as Env["BUCKET"]
}

const bytesOf = (text: string) => new TextEncoder().encode(text)

describe("attachment filenames and keys", () => {
	it("keeps a plain filename, including non-Latin characters", () => {
		expect(sanitizeAttachmentFilename("statement-มกราคม.pdf")).toBe("statement-มกราคม.pdf")
	})

	it("replaces path separators so a filename cannot add key segments", () => {
		expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe(".._.._etc_passwd")
		expect(sanitizeAttachmentFilename("a\\b")).toBe("a_b")
	})

	it("replaces control characters that a header could carry", () => {
		expect(sanitizeAttachmentFilename("a\u0000b\u001fc")).toBe("a_b_c")
	})

	it("names a missing filename untitled", () => {
		expect(sanitizeAttachmentFilename(null)).toBe("untitled")
		expect(sanitizeAttachmentFilename("")).toBe("untitled")
	})

	it("builds the one key the store and the reader share", () => {
		expect(attachmentObjectKey("e1", "a1", "receipt.pdf")).toBe("attachments/e1/a1/receipt.pdf")
	})

	it("sanitizes inside the key, so both callers agree", () => {
		expect(attachmentObjectKey("e1", "a1", "../x.pdf")).toBe("attachments/e1/a1/.._x.pdf")
	})
})

describe("attachment bodies for an agent", () => {
	it("reads a text attachment as text", () => {
		expect(attachmentBodyFor("text/plain", bytesOf("hello"))).toEqual({
			kind: "text",
			content: "hello",
			truncated: false,
		})
	})

	it("treats JSON and XML as text", () => {
		expect(isTextMimeType("application/json")).toBe(true)
		expect(isTextMimeType("application/ld+json")).toBe(true)
		expect(isTextMimeType("image/svg+xml")).toBe(true)
		expect(isTextMimeType("application/pdf")).toBe(false)
	})

	it("returns binary content as base64", () => {
		expect(attachmentBodyFor("application/pdf", bytesOf("hello"))).toEqual({
			kind: "base64",
			content: "aGVsbG8=",
		})
	})

	it("marks text over the character cap truncated instead of dropping it", () => {
		const body = attachmentBodyFor("text/csv", bytesOf("x".repeat(MAX_INLINE_ATTACHMENT_CHARS + 5)))
		expect(body.kind).toBe("text")
		if (body.kind !== "text") throw new Error("expected text")
		expect(body.truncated).toBe(true)
		expect(body.content.length).toBe(MAX_INLINE_ATTACHMENT_CHARS)
	})

	it("refuses a file over the byte cap rather than truncating it", () => {
		expect(attachmentBodyFor("application/pdf", bytesOf("12345"), 4)).toEqual({
			kind: "too_large",
			sizeBytes: 5,
			limitBytes: 4,
		})
	})

	it("accepts a file exactly at the byte cap", () => {
		expect(attachmentBodyFor("application/pdf", bytesOf("1234"), 4).kind).toBe("base64")
	})
})

describe("attachment read errors", () => {
	it("gives each refusal code its own sentence", () => {
		expect(attachmentReadErrorMessage("attachment_not_found")).toBe(
			"No attachment with that id in this mailbox",
		)
		expect(attachmentReadErrorMessage("attachment_file_missing")).toBe(
			"The attachment is recorded, but its file is missing",
		)
		expect(attachmentReadErrorMessage("attachment_too_large")).toBe(
			"The attachment is larger than the inline limit",
		)
		expect(attachmentReadErrorMessage("attachment_not_readable")).toBe(
			"Only text attachments can be read this way",
		)
	})
})

describe("reading an attachment from R2", () => {
	it("reads the object at the key the store wrote", async () => {
		const reads: string[] = []
		const bucket = fakeBucket(new Map([["attachments/e1/a1/note.txt", bytesOf("hello")]]), reads)
		expect(await readAttachmentBody(bucket, record)).toEqual({
			kind: "text",
			content: "hello",
			truncated: false,
		})
		expect(reads).toEqual(["attachments/e1/a1/note.txt"])
	})

	it("returns null when the row has no object behind it", async () => {
		expect(await readAttachmentBody(fakeBucket(new Map()), record)).toBeNull()
	})

	it("refuses an oversized object from its size, without reading it", async () => {
		let read = false
		const bucket = {
			get: async () => ({
				size: MAX_INLINE_ATTACHMENT_BYTES + 1,
				arrayBuffer: async () => {
					read = true
					return new ArrayBuffer(0)
				},
			}),
		} as unknown as Env["BUCKET"]

		expect(await readAttachmentBody(bucket, record)).toEqual({
			kind: "too_large",
			sizeBytes: MAX_INLINE_ATTACHMENT_BYTES + 1,
			limitBytes: MAX_INLINE_ATTACHMENT_BYTES,
		})
		expect(read).toBe(false)
	})
})

describe("text attachments with MIME parameters", () => {
	it("reads a MIME type that carries a charset as text", () => {
		expect(isTextMimeType("application/json; charset=utf-8")).toBe(true)
		expect(attachmentBodyFor("text/plain; charset=utf-8", bytesOf("ok")).kind).toBe("text")
	})

	it("never cuts a surrogate pair in half at the cap", () => {
		const body = attachmentBodyFor(
			"text/plain",
			bytesOf(`${"x".repeat(MAX_INLINE_ATTACHMENT_CHARS - 1)}😀`),
		)
		if (body.kind !== "text") throw new Error("expected text")
		expect(body.truncated).toBe(true)
		expect(body.content.length).toBe(MAX_INLINE_ATTACHMENT_CHARS - 1)
		expect(body.content.endsWith("x")).toBe(true)
	})
})
