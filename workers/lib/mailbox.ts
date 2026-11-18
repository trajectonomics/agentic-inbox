// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory"
import type { MailboxDO } from "../durableObject"
import type { Env } from "../types"

export type MailboxContext = {
	Bindings: Env
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>
	}
}

/**
 * The one mailbox-id normalization. Hono has already decoded the path param,
 * so the canonical id is just the address lowercased. The listing object, the
 * Durable Object id and every delete use this, so they cannot address
 * different stores for the same Mailbox.
 */
export function normalizeMailboxId(raw: string): string {
	return raw.toLowerCase()
}

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId")
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400)
	const mailboxId = normalizeMailboxId(rawId)

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`
	const obj = await c.env.BUCKET.head(key)
	if (!obj) {
		return c.json({ error: "Not found" }, 404)
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX
	const id = ns.idFromName(mailboxId)
	const stub = ns.get(id)

	c.set("mailboxStub", stub)

	await next()
})
