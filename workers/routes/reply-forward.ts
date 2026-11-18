// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reply and forward: find the message being answered, build its threading,
 * and let the outgoing-send rule do the rest.
 */
import type { Context } from "hono"
import { buildReferencesChain, resolveOriginalEmail } from "../lib/email-helpers"
import type { MailboxContext } from "../lib/mailbox"
import { sendAndRecord } from "../lib/outgoing-send"
import { type EmailFull, SendEmailRequestSchema } from "../lib/schemas"
import { respondToSendResult } from "./send-response"

type AppContext = Context<MailboxContext>

/**
 * `POST /api/v1/mailboxes/:mailboxId/emails/:id/reply`: send a reply, record
 * it only if it was accepted, and mark the thread read only then.
 */
export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? ""
	const id = c.req.param("id") ?? ""
	const body = SendEmailRequestSchema.parse(await c.req.json())

	const stub = c.var.mailboxStub
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404)
	}

	// A draft replies to the message it answers, not to itself.
	const originalEmail = await resolveOriginalEmail(stub, rawOriginal)
	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail)

	const result = await sendAndRecord(c.env, stub, {
		mailboxId,
		body,
		threading: { inReplyTo: originalMsgId, references, threadId, markThreadRead: true },
	})

	return respondToSendResult(c, result)
}

/**
 * `POST /api/v1/mailboxes/:mailboxId/emails/:id/forward`: send a new message
 * that carries the forwarded content. It starts its own thread.
 */
export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? ""
	const id = c.req.param("id") ?? ""
	const body = SendEmailRequestSchema.parse(await c.req.json())

	const original = (await c.var.mailboxStub.getEmail(id)) as EmailFull | null

	if (!original) {
		return c.json({ error: "Original email not found" }, 404)
	}

	const result = await sendAndRecord(c.env, c.var.mailboxStub, {
		mailboxId,
		body,
		threading: {},
	})

	return respondToSendResult(c, result)
}
