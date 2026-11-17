// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Attachment rules, storage and retrieval.
 *
 * The key a file is written under and the key it is read under come from
 * `attachmentObjectKey`, so the store, the inbound path, the download route
 * and the agent reader cannot drift apart. Everything that shapes an
 * attachment for an agent is pure; only `storeAttachments` and
 * `readAttachmentBody` touch R2.
 */
import type { Env } from "../types"

/** Largest attachment body an agent receives inline, in bytes. */
export const MAX_INLINE_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Longest text attachment body an agent receives inline, in characters. */
export const MAX_INLINE_ATTACHMENT_CHARS = 200_000

/**
 * Why an agent could not read an attachment. One code per rule; never widen
 * a code's meaning.
 */
export type AttachmentReadError =
	| "attachment_not_found"
	| "attachment_file_missing"
	| "attachment_too_large"
	| "attachment_not_readable"

/** An attachment row as the mailbox database stores it. */
export interface AttachmentRecord {
	id: string
	email_id: string
	filename: string
	mimetype: string
	size: number
	content_id?: string | null
	disposition?: string | null
}

/** One attachment with the email it arrived on, as `list_attachments` returns it. */
export interface AttachmentSummary extends AttachmentRecord {
	email_subject: string | null
	email_sender: string | null
	email_date: string | null
}

/**
 * The body of one attachment, shaped for an agent: text stays text, binary
 * becomes base64, and a file over the inline limit is refused rather than
 * truncated.
 */
export type AttachmentBody =
	| { kind: "text"; content: string; truncated: boolean }
	| { kind: "base64"; content: string }
	| { kind: "too_large"; sizeBytes: number; limitBytes: number }

/** The attachments a caller sends with an email, after decoding base64. */
export interface StoredAttachment {
	id: string
	email_id: string
	filename: string
	mimetype: string
	size: number
	content_id: string | null
	disposition: string
}

/** The characters Windows rejects, plus the two path separators. */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/g

/**
 * The one sentence a person reads for a refusal code. One sentence per code,
 * so a new rule never borrows another rule's wording.
 */
export function attachmentReadErrorMessage(error: AttachmentReadError): string {
	switch (error) {
		case "attachment_not_found":
			return "No attachment with that id in this mailbox"
		case "attachment_file_missing":
			return "The attachment is recorded, but its file is missing"
		case "attachment_too_large":
			return "The attachment is larger than the inline limit"
		case "attachment_not_readable":
			return "Only text attachments can be read this way"
	}
}

/**
 * Make a filename safe for a single R2 key segment and for storage.
 *
 * Removes path separators, control characters and the characters Windows
 * rejects. An empty or missing name becomes `untitled`, which is what the
 * inbound path has always stored.
 */
export function sanitizeAttachmentFilename(raw: string | null | undefined): string {
	const replaced = (raw || "untitled").replace(UNSAFE_FILENAME_CHARS, "_")
	let safe = ""
	for (const character of replaced) {
		safe += (character.codePointAt(0) ?? 0) < 0x20 ? "_" : character
	}
	return safe
}

/**
 * The one R2 key an attachment is stored at and read from: the email, the
 * attachment id and the sanitized filename. The id keeps the key unique even
 * when two files share a name.
 */
export function attachmentObjectKey(
	emailId: string,
	attachmentId: string,
	filename: string,
): string {
	return `attachments/${emailId}/${attachmentId}/${sanitizeAttachmentFilename(filename)}`
}

/**
 * Whether a MIME type is text an agent can read directly. Covers `text/*` and
 * the structured types that are JSON or XML in practice.
 */
export function isTextMimeType(mimetype: string): boolean {
	const type = mimetype.split(";")[0].trim().toLowerCase()
	return (
		type.startsWith("text/") ||
		type === "application/json" ||
		type === "application/xml" ||
		type === "application/x-ndjson" ||
		type.endsWith("+json") ||
		type.endsWith("+xml")
	)
}

/**
 * Shape attachment bytes for an agent. Text is decoded and capped at
 * `MAX_INLINE_ATTACHMENT_CHARS` (marked truncated); anything else is base64.
 * A file over `maxBytes` is refused, because a silently shortened bank
 * statement is worse than no answer.
 */
export function attachmentBodyFor(
	mimetype: string,
	bytes: Uint8Array,
	maxBytes: number = MAX_INLINE_ATTACHMENT_BYTES,
): AttachmentBody {
	if (bytes.byteLength > maxBytes) {
		return { kind: "too_large", sizeBytes: bytes.byteLength, limitBytes: maxBytes }
	}

	if (isTextMimeType(mimetype)) {
		const text = new TextDecoder("utf-8").decode(bytes)
		if (text.length > MAX_INLINE_ATTACHMENT_CHARS) {
			return { kind: "text", content: truncateAtSafeBoundary(text), truncated: true }
		}
		return { kind: "text", content: text, truncated: false }
	}

	return { kind: "base64", content: base64FromBytes(bytes) }
}

/**
 * Store base64-encoded attachments in R2 and return the rows the mailbox
 * database keeps. This is the one place outgoing attachment content is
 * decoded.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string
		filename: string
		type: string
		disposition: string
		contentId?: string
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return []

	const results: StoredAttachment[] = []
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID()
		const filename = sanitizeAttachmentFilename(att.filename)
		const key = attachmentObjectKey(emailId, attachmentId, filename)
		const binaryStr = atob(att.content)
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0))
		await bucket.put(key, bytes)
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		})
	}
	return results
}

/**
 * Read one attachment's bytes from R2 and shape them for an agent.
 *
 * Returns null when the row exists but the object does not, so the caller can
 * report `attachment_file_missing` instead of an empty file.
 */
export async function readAttachmentBody(
	bucket: Env["BUCKET"],
	attachment: AttachmentRecord,
): Promise<AttachmentBody | null> {
	const key = attachmentObjectKey(attachment.email_id, attachment.id, attachment.filename)
	const object = await bucket.get(key)
	if (!object) return null

	// Refuse an oversized file from its metadata, before buffering it.
	if (object.size > MAX_INLINE_ATTACHMENT_BYTES) {
		return {
			kind: "too_large",
			sizeBytes: object.size,
			limitBytes: MAX_INLINE_ATTACHMENT_BYTES,
		}
	}

	return attachmentBodyFor(attachment.mimetype, new Uint8Array(await object.arrayBuffer()))
}

/**
 * Cut text at the character cap without leaving half a surrogate pair, which
 * would be an invalid string in the JSON an agent receives.
 */
function truncateAtSafeBoundary(text: string): string {
	const cut = text.slice(0, MAX_INLINE_ATTACHMENT_CHARS)
	const lastCode = cut.charCodeAt(cut.length - 1)
	const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff
	return isHighSurrogate ? cut.slice(0, -1) : cut
}

/**
 * Base64 of arbitrary bytes in chunks, so a large attachment cannot overflow
 * the argument limit of `String.fromCharCode`.
 */
function base64FromBytes(bytes: Uint8Array): string {
	const chunkBytes = 0x8000
	let binary = ""
	for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes))
	}
	return btoa(binary)
}
