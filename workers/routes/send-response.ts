// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The HTTP answer an outgoing-send verdict becomes. The rule itself returns a
 * verdict, so the statuses live here, in one place for all three send routes.
 */
import type { Context } from "hono"
import type { MailboxContext } from "../lib/mailbox"
import type { OutgoingSendResult } from "../lib/outgoing-send"

/**
 * Map a send verdict to its response: `200 {id, status}` when the binding
 * accepted and the Message was recorded, `200 {status}` when an accepted send
 * could not be recorded, `400` for a sender that does not match the mailbox,
 * `429` from the rate limit, and `502` when the binding refused, carrying the
 * reason the composer shows.
 */
export function respondToSendResult(
	c: Context<MailboxContext>,
	result: OutgoingSendResult,
): Response {
	switch (result.status) {
		case "sent":
			return c.json({ ...(result.id ? { id: result.id } : {}), status: "sent" }, 200)
		case "invalid_sender":
			return c.json({ error: result.error }, 400)
		case "rate_limited":
			return c.json({ error: result.error }, 429)
		case "not_sent":
			return c.json({ error: result.error }, 502)
	}
}
