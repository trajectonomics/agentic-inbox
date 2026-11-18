// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one outgoing-send rule: send before recording, and report only what
 * happened (docs/adr/0001).
 *
 * Every browser send route — new mail, reply and forward — goes through
 * `sendAndRecord`. It validates the sender, checks the send rate limit,
 * awaits the Email Service binding, and only when the binding accepts the
 * message writes the attachments to R2 and the Message into the `sent`
 * folder, marking a reply's Thread read last. A refused send records nothing
 * and returns the refusal, so the composer keeps the draft instead of showing
 * a message that never left.
 */
import { Folders } from "../../shared/folders"
import { sendEmail } from "../email-sender"
import type { Env } from "../types"
import { type StoredAttachment, storeAttachments } from "./attachments"
import {
	buildThreadingHeaders,
	generateMessageId,
	joinRecipients,
	normalizeMessageId,
	SenderValidationError,
	validateSender,
} from "./email-helpers"
import { type OutgoingMessage, OutgoingMessageSchema, type SendEmailRequest } from "./schemas"

/**
 * The mailbox calls an outgoing send makes. Structural on purpose, so the
 * rule is testable with a plain fake and without a Durable Object, and so the
 * typed mailbox stub satisfies it with no adapter or cast. An outgoing send
 * records only into the sent folder, so that folder is not a choice here.
 */
export interface OutgoingRecorder {
	checkSendRateLimit(): Promise<string | null>
	createEmail(
		folder: typeof Folders.SENT,
		message: OutgoingMessage,
		attachments: StoredAttachment[],
	): Promise<void>
	markThreadRead(threadId: string): Promise<unknown>
}

/** How one route threads its send: the only thing that differs between the routes. */
export interface OutgoingThreading {
	/** The message id this send answers, if any. */
	inReplyTo?: string | null
	/** The References chain the send continues, if any. */
	references?: string[]
	/** The Thread the Message joins; defaults to the replied-to id, else its own id. */
	threadId?: string | null
	/** Whether an accepted send marks the Thread read (replies do, forward and new mail do not). */
	markThreadRead?: boolean
}

/** One outgoing Message: the mailbox, the validated request body and its threading. */
export interface OutgoingSend {
	mailboxId: string
	body: SendEmailRequest
	threading: OutgoingThreading
}

/**
 * What happened to an outgoing message. One status per rule; never widen one
 * status to cover another.
 */
export type OutgoingSendResult =
	| { status: "sent"; id: string }
	| { status: "invalid_sender"; error: string }
	| { status: "rate_limited"; error: string }
	| { status: "not_sent"; error: string }

/** The bindings one send needs. */
type SendEnv = Pick<Env, "EMAIL" | "BUCKET">

/**
 * Send one outgoing message and record it, in that order.
 *
 * Returns a verdict rather than a response, so the route keeps the status
 * mapping. `sent` carries the recorded Message's row id. `invalid_sender`
 * (400), `rate_limited` (429) and `not_sent` (502) each carry the message to
 * show. A send the binding accepted is `sent` even if recording it fails:
 * the mail is out and the Email Service has no idempotency key, so an error
 * status would invite the person to send it twice.
 */
export async function sendAndRecord(
	env: SendEnv,
	recorder: OutgoingRecorder,
	send: OutgoingSend,
): Promise<OutgoingSendResult> {
	const { to, cc, bcc, from, subject, html, text, attachments } = send.body

	let toStr: string
	let fromEmail: string
	let fromDomain: string
	try {
		;({ toStr, fromEmail, fromDomain } = validateSender(to, from, send.mailboxId))
	} catch (e) {
		if (e instanceof SenderValidationError) return { status: "invalid_sender", error: e.message }
		throw e
	}

	const rateLimitError = await recorder.checkSendRateLimit()
	if (rateLimitError) return { status: "rate_limited", error: rateLimitError }

	const { messageId: rowId, outgoingMessageId } = generateMessageId(fromDomain)
	const inReplyTo = send.threading.inReplyTo || null
	const references = send.threading.references ?? []

	let sentMessageId: string
	try {
		const sent = await sendEmail(env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments,
			...(inReplyTo ? { headers: buildThreadingHeaders(inReplyTo, references) } : {}),
		})
		sentMessageId = normalizeMessageId(sent.messageId) ?? outgoingMessageId
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e)
		console.error("Email send failed:", reason)
		return { status: "not_sent", error: `Failed to send email: ${reason}` }
	}

	const date = new Date().toISOString()
	const threadId = send.threading.threadId || inReplyTo || rowId
	try {
		const attachmentRows = await storeAttachments(env.BUCKET, rowId, attachments)
		await recorder.createEmail(
			Folders.SENT,
			OutgoingMessageSchema.parse({
				id: rowId,
				subject,
				sender: fromEmail,
				recipient: toStr,
				cc: joinRecipients(cc),
				bcc: joinRecipients(bcc),
				date,
				body: html || text || "",
				in_reply_to: inReplyTo,
				email_references: references.length > 0 ? JSON.stringify(references) : null,
				thread_id: threadId,
				message_id: sentMessageId,
				raw_headers: JSON.stringify(
					sentHeaders({ to, cc, bcc, from, subject, date, sentMessageId, inReplyTo, references }),
				),
			}),
			attachmentRows,
		)
		if (send.threading.markThreadRead) await recorder.markThreadRead(threadId)
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e)
		console.error("Sent message could not be recorded:", reason)
	}

	return { status: "sent", id: rowId }
}

/**
 * The headers blob a stored Message carries, including the id it was sent
 * with. Its threading entries come from the same rule as the wire headers, so
 * what a reader sees in the source cannot drift from what the recipient saw.
 */
function sentHeaders(message: {
	to: string | string[]
	cc?: string | string[]
	bcc?: string | string[]
	from: string | { email: string; name: string }
	subject: string
	date: string
	sentMessageId: string
	inReplyTo: string | null
	references: string[]
}): { key: string; value: string }[] {
	const { to, cc, bcc, from, subject, date, sentMessageId, inReplyTo, references } = message
	return [
		{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
		{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
		...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
		...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
		{ key: "subject", value: subject },
		{ key: "date", value: date },
		{ key: "message-id", value: `<${sentMessageId}>` },
		...threadingHeaderEntries(inReplyTo, references),
	]
}

/** The In-Reply-To and References entries, named as the binding sends them. */
function threadingHeaderEntries(
	inReplyTo: string | null,
	references: string[],
): { key: string; value: string }[] {
	if (!inReplyTo) return []
	return Object.entries(buildThreadingHeaders(inReplyTo, references)).map(([key, value]) => ({
		key: key.toLowerCase(),
		value,
	}))
}
