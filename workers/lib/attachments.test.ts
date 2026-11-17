import { describe, expect, it } from "bun:test"
import {
	attachmentBodyFor,
	attachmentObjectKey,
	attachmentReadErrorMessage,
	isTextMimeType,
	MAX_INLINE_ATTACHMENT_CHARS,
	sanitizeAttachmentFilename,
} from "./attachments"

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
