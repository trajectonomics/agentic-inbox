# 0001. Record an outgoing message only after the Email binding accepts it

- **Status**: Accepted

## Context

The browser send routes — new mail, reply and forward — used to write the message into the `sent` folder first, hand delivery to the runtime to finish after the response, and answer `202 {status: "sent"}` at once. When the Cloudflare Email Service binding refused or could not deliver the message, the copy stayed in `sent` for ever, nothing retried, and the only trace was one console line. The composer had already shown "Email sent!" and closed.

The same refusal also spent the mailbox's send quota, because the rate limit counts rows in the `sent` folder, so a message that was never sent cost the same as one that was.

The agent's send tools already did the opposite: they awaited the binding, returned an error when it refused, and recorded the copy only after it accepted. The browser routes were the outliers, not the rule.

Two properties of the send path decide the rest:

- The Email Service binding throws on validation and delivery errors, and returns the message id it sent the mail with. That id is what reached the wire; the local id generated before the send never did.
- Attachments reach the binding from the request body, base64 encoded, not from R2, so their R2 objects need not exist for delivery to happen.

The browser client shows `error` from a non-2xx response, keeps the draft, and bounds the request at 30 seconds. Nothing in the client depended on the `202`: any non-2xx is an error and the body is otherwise unread.

## Decision

An outgoing message is sent before it is recorded, and the response says only what happened.

1. The Email binding is awaited before anything is written: no `waitUntil`, no deferred send.
2. A refusal records nothing — no copy in the `sent` folder, no R2 attachment, no read-state change — and the request answers `502 {error}`, carrying the binding's message so the person reads the reason and keeps the draft.
3. An accepted send records the copy, storing the message id the binding reports (normalised to a bare id, the same way the inbound path normalises the `Message-ID` header) and writing the same id into the stored headers. A reply marks its thread read only now. If the binding reports no id, the locally generated id is stored.
4. Acceptance is the point of no return. If writing the copy fails after the binding accepted the message — a storage or Durable Object error — the failure is logged loudly and the response stays a success, because the mail is already out and the Email Service offers no idempotency key: an error status would invite the person to send it twice.
5. One module owns the sequence for every browser send path, so a new route cannot reintroduce the deferred send. The agent's send tools keep their own implementation and already follow this rule.
6. Statuses: `200 {id, status: "sent"}` on accept, `400` when the sender does not match the mailbox, `429` from the rate limit, `502` when the binding refuses. The rate limit is checked before the send, so a mailbox over its limit never delivers anything, and a refused send no longer spends quota.

## Consequences

- Every message in the `sent` folder was accepted by the mail service, so the folder is a record a person can trust instead of a record of attempts.
- A person whose send fails sees the reason and keeps their draft, on all three routes, with no UI change: the composer's existing error path is the whole feature.
- A failed send leaves nothing behind, so no cleanup helper is needed for attachments or read state, and a failed reply leaves its thread unread.
- A send now waits for the mail service before the app says "sent", which adds a second or two to every send. That latency is the price of the truth.
- A send that is merely slow can outlast the browser's 30-second timeout: the composer then reports the abort and keeps the draft while the Worker finishes the send and records it. The `sent` folder is the truth in that moment, and a hasty retry can duplicate the message. This is accepted, because no idempotency key exists to make a retry safe, and it is a far smaller cost than a reply silently lost.
- A recording failure after an accepted send is the one case where the `sent` folder under-reports: the mail is out but unlisted. It is logged, and it is rare enough to prefer over a duplicate send.
- Out of scope by design: retrying a failed send, queueing it, detecting bounces, and a failed-message folder. The first two can duplicate without an idempotency key, and the last touches the canonical folders, the mailbox schema and the sidebar — a different decision, which would supersede this record's item 2 if it were ever taken.
