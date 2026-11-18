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
	type SenderValidationCode,
	SenderValidationError,
	validateSender,
} from "./email-helpers"
import {
	type OutgoingMessage,
	OutgoingMessageSchema,
	type SendEmailRequest,
	StoredAttachmentSchema,
} from "./schemas"

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
	markThreadRead(threadId: string): Promise<void>
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
 * status to cover another. A sender refusal carries the code of the rule it
 * broke. `sent` carries the recorded Message's id only when the recording
 * succeeded; an accepted send whose recording failed has no row to name.
 */
export type OutgoingSendResult =
	| { status: "sent"; id?: string }
	| { status: "invalid_sender"; code: SenderValidationCode; error: string }
	| { status: "rate_limited"; error: string }
	| { status: "not_sent"; error: string }

/** The bindings one send needs. */
type SendEnv = Pick<Env, "EMAIL" | "BUCKET">

/**
 * Send one outgoing message and record it, in that order.
 *
 * Returns a verdict rather than a response, so the route keeps the status
 * mapping. When recording succeeds, `sent` carries the Message's row id;
 * when it fails, `sent` has no id because nothing was recorded.
 * `invalid_sender` (400), `rate_limited` (429) and `not_sent` (502) each carry
 * the message to show. A send the binding accepted is `sent` even if recording
 * it fails: the mail is out and the Email Service has no idempotency key, so
 * an error status would invite the person to send it twice.
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
		if (e instanceof SenderValidationError) {
			return { status: "invalid_sender", code: e.code, error: e.message }
		}
		throw e
	}

	const rateLimitError = await recorder.checkSendRateLimit()
	if (rateLimitError) return { status: "rate_limited", error: rateLimitError }

	const { rowId, outgoingMessageId } = generateMessageId(fromDomain)
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
	const ccStr = joinRecipients(cc)
	const bccStr = joinRecipients(bcc)

	// A schema violation is our own construction being wrong, not a storage
	// failure. Parse outside the recording catch so it cannot be logged away
	// as a successful send that merely failed to be recorded.
	const message = OutgoingMessageSchema.parse({
		id: rowId,
		subject,
		sender: fromEmail,
		recipient: toStr,
		cc: ccStr,
		bcc: bccStr,
		date,
		body: html || text || "",
		in_reply_to: inReplyTo,
		email_references: references.length > 0 ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: sentMessageId,
		raw_headers: JSON.stringify(
			sentHeaders({
				to: toStr,
				cc: ccStr,
				bcc: bccStr,
				from,
				subject,
				date,
				sentMessageId,
				inReplyTo,
				references,
			}),
		),
	})

	let recorded = false
	try {
		const attachmentRows = StoredAttachmentSchema.array().parse(
			await storeAttachments(env.BUCKET, rowId, attachments),
		)
		await recorder.createEmail(Folders.SENT, message, attachmentRows)
		recorded = true
		if (send.threading.markThreadRead) await recorder.markThreadRead(threadId)
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e)
		console.error("Sent message could not be recorded:", reason)
	}

	return recorded ? { status: "sent", id: rowId } : { status: "sent" }
}

/**
 * The headers blob a stored Message carries, including the id it was sent
 * with. Recipient entries use the one `joinRecipients` normalisation, so the
 * blob and the columns cannot disagree; threading entries come from the same
 * rule as the wire headers, so the source cannot drift from the recipient's copy.
 */
function sentHeaders(message: {
	to: string
	cc: string | null
	bcc: string | null
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
		{ key: "to", value: to },
		...(cc ? [{ key: "cc", value: cc }] : []),
		...(bcc ? [{ key: "bcc", value: bcc }] : []),
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
