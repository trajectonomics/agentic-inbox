// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import { Folders } from "../../shared/folders"
import { sendEmail } from "../email-sender"
import type { Env } from "../types"
import { verifyDraft } from "./ai"
import {
	type AttachmentReadError,
	type AttachmentRecord,
	type AttachmentSummary,
	attachmentReadErrorMessage,
	isTextMimeType,
	readAttachmentBody,
} from "./attachments"
import { deleteEmailAndFiles } from "./delete"
import {
	buildQuotedReplyBlock,
	buildReferencesChain,
	buildThreadingHeaders,
	generateMessageId,
	getFullEmail,
	getFullThread,
	getMailboxStub,
	listMailboxes,
	textToHtml,
} from "./email-helpers"
import type { EmailFull } from "./schemas"

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: { query: string; folder?: string }) => Promise<unknown>
}

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>
}

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET)
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId)
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	})
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId)
	const email = await getFullEmail(stub, emailId)
	if (!email) return { error: "Email not found" }
	return email
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(env: Env, mailboxId: string, threadId: string) {
	const stub = getMailboxStub(env, mailboxId)
	return getFullThread(stub, threadId)
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId)
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	})
}

// ── list_attachments ───────────────────────────────────────────────

/** The filters `list_attachments` accepts; every field is optional. */
export interface ListAttachmentsInput {
	emailId?: string
	mimetype?: string
	sender?: string
	since?: string
	until?: string
	includeInline?: boolean
	limit?: number
	offset?: number
}

/**
 * List the files attached to a mailbox's mail, newest first, each with the
 * subject, sender and date of the email it arrived on.
 */
export async function toolListAttachments(
	env: Env,
	mailboxId: string,
	params: ListAttachmentsInput = {},
): Promise<{ attachments: AttachmentSummary[] }> {
	const stub = getMailboxStub(env, mailboxId)
	const attachments = await stub.listAttachments(params)
	return { attachments }
}

// ── get_attachment ─────────────────────────────────────────────────

/** The body of one attachment, or the one code that says why it is absent. */
export type AttachmentToolResult =
	| {
			attachment: AttachmentRecord
			encoding: "text" | "base64"
			content: string
			truncated?: boolean
	  }
	| {
			error: AttachmentReadError
			message: string
			sizeBytes?: number
			limitBytes?: number
	  }

/**
 * How much of an attachment the caller can use. `bytes` returns binary as
 * base64 for a client that can write a file; `text` refuses binary, which is
 * what a chat model needs, because PDF bytes in a prompt help nobody.
 */
export type AttachmentReadMode = "bytes" | "text"

/**
 * Read one attachment's bytes for the caller's agent. Text stays text;
 * anything else is base64 in `bytes` mode and refused in `text` mode. A file
 * over the inline limit is refused with its size, never silently shortened.
 */
export async function toolGetAttachment(
	env: Env,
	mailboxId: string,
	attachmentId: string,
	mode: AttachmentReadMode = "bytes",
): Promise<AttachmentToolResult> {
	const stub = getMailboxStub(env, mailboxId)
	const attachment = await stub.getAttachment(attachmentId)
	if (!attachment) {
		return {
			error: "attachment_not_found",
			message: attachmentReadErrorMessage("attachment_not_found"),
		}
	}

	// A chat model gets nothing from binary bytes, so refuse before reading them.
	if (mode === "text" && !isTextMimeType(attachment.mimetype)) {
		return {
			error: "attachment_not_readable",
			message: attachmentReadErrorMessage("attachment_not_readable"),
		}
	}

	const body = await readAttachmentBody(env.BUCKET, attachment)
	if (!body) {
		return {
			error: "attachment_file_missing",
			message: attachmentReadErrorMessage("attachment_file_missing"),
		}
	}

	if (body.kind === "too_large") {
		return {
			error: "attachment_too_large",
			message: `${attachmentReadErrorMessage("attachment_too_large")}: ${body.sizeBytes} bytes, limit ${body.limitBytes} bytes`,
			sizeBytes: body.sizeBytes,
			limitBytes: body.limitBytes,
		}
	}

	return {
		attachment,
		encoding: body.kind === "text" ? "text" : "base64",
		content: body.content,
		...(body.kind === "text" && body.truncated ? { truncated: true } : {}),
	}
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string
		to: string
		subject: string
		body: string
		isPlainText?: boolean
		runVerifyDraft?: boolean
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId)

	// Verify/sanitize if requested
	let processedBody = params.body.trim()
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody)
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." }
		}
		processedBody = sanitized
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody)
	}

	const draftId = crypto.randomUUID()

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null
	const threadId = original?.thread_id || params.originalEmailId

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: ""
	const bodyHtml = processedBody + quotedBlock

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	)

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	}
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string
		subject: string
		body: string
		isPlainText?: boolean
		runVerifyDraft?: boolean
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string
		/** Optional thread_id for create_draft style */
		thread_id?: string
	},
): Promise<
	| {
			status: string
			draftId: string
			threadId?: string
			message: string
			draft?: Record<string, string>
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId)

	let processedBody = params.body.trim()
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody)
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." }
		}
		processedBody = sanitized
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody)
	}

	const draftId = crypto.randomUUID()

	// Resolve thread ID
	let resolvedThreadId = params.thread_id
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null
		resolvedThreadId = original?.thread_id || params.in_reply_to
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	)

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	}
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string
		to?: string
		subject?: string
		bodyHtml?: string
	},
): Promise<
	{ status: string; newDraftId: string; oldDraftId: string; message: string } | { error: string }
> {
	const stub = getMailboxStub(env, mailboxId)

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null
	if (!oldDraft) {
		return { error: "Draft not found" }
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID()
	const rawBody = params.bodyHtml ?? oldDraft.body ?? ""
	const verifiedBody = await verifyDraft(env.AI, rawBody)

	if (!verifiedBody) {
		return {
			error: "Draft verification failed — keeping existing draft unchanged. Please try again.",
		}
	}

	const deletion = await deleteEmailAndFiles(env, mailboxId, params.draftId)
	if (deletion.status === "attachment_delete_failed") {
		return { error: deletion.error }
	}
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	)

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	}
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId)
	await stub.updateEmail(emailId, { read })
	return { status: "updated", emailId, read }
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId)
	const success = await stub.moveEmail(emailId, folderId)
	if (success) {
		return { status: "moved", emailId, folder: folderId }
	}
	return { error: "Failed to move email" }
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(env: Env, mailboxId: string, draftId: string) {
	const stub = getMailboxStub(env, mailboxId)
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null
	if (!email) {
		return { error: "Draft not found" }
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" }
	}
	const deletion = await deleteEmailAndFiles(env, mailboxId, draftId)
	if (deletion.status === "attachment_delete_failed") {
		return { error: deletion.error }
	}
	return { status: "discarded", draftId }
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<
	| { status: "deleted"; emailId: string; attachmentsDeletedCount: number }
	| { error: string; emailId: string }
> {
	const result = await deleteEmailAndFiles(env, mailboxId, emailId)
	switch (result.status) {
		case "email_not_found":
			return { error: "Email not found", emailId }
		case "attachment_delete_failed":
			return { error: result.error, emailId }
		case "deleted":
			return {
				status: "deleted",
				emailId,
				attachmentsDeletedCount: result.attachmentsDeletedCount,
			}
	}
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string
		to: string
		subject: string
		bodyHtml: string
	},
): Promise<{ status: "sent"; messageId: string; message: string } | { error: string }> {
	const stub = getMailboxStub(env, mailboxId)

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit()
	if (rateLimitError) {
		return { error: rateLimitError }
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null
	if (!originalEmail) {
		return { error: "Original email not found" }
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail)
	const fromDomain = mailboxId.split("@")[1]
	if (!fromDomain) throw new Error("Invalid mailbox email address")
	const { rowId, outgoingMessageId } = generateMessageId(fromDomain)

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml)
	if (!sanitizedBody) {
		return {
			error: "Draft verification failed — refusing to send unverified content. Please try again.",
		}
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	})
	const fullBodyHtml = sanitizedBody + quotedBlock

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		})
	} catch (e) {
		console.error("Email send failed:", (e as Error).message)
		return { error: `Failed to send reply: ${(e as Error).message}` }
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: rowId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references: references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	)

	return { status: "sent", messageId: rowId, message: `Reply sent to ${params.to}` }
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string
		subject: string
		bodyHtml: string
	},
): Promise<{ status: "sent"; messageId: string; message: string } | { error: string }> {
	const stub = getMailboxStub(env, mailboxId)

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit()
	if (rateLimitError) {
		return { error: rateLimitError }
	}

	const fromDomain = mailboxId.split("@")[1]
	if (!fromDomain) throw new Error("Invalid mailbox email address")
	const { rowId, outgoingMessageId } = generateMessageId(fromDomain)

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml)
	if (!sanitizedBody) {
		return {
			error: "Draft verification failed — refusing to send unverified content. Please try again.",
		}
	}

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
		})
	} catch (e) {
		console.error("Email send failed:", (e as Error).message)
		return { error: `Failed to send email: ${(e as Error).message}` }
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: rowId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: rowId,
			message_id: outgoingMessageId,
		},
		[],
	)

	return { status: "sent", messageId: rowId, message: `Email sent to ${params.to}` }
}
