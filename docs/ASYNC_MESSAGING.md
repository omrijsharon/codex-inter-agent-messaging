# Asynchronous Messaging

Asynchronous messaging adds explicit, durable network edges without automatic agent ping-pong. It uses the same authenticated registry, FIFO scheduler, recipient leases, idle checks, retry policy, and audit trail as synchronous `ask_agent`.

## Semantics

- `send_message` persists a `request` or `notice` and immediately returns its stable message/conversation ID and current delivery status.
- Delivery starts only while the exact registered recipient generation is idle. Busy or temporarily unavailable recipients remain queued.
- The recipient receives `ASYNC_INTER_AGENT_MESSAGE_V1` as a real turn. Its assistant output is deliberately discarded by the network layer.
- `read_inbox` returns delivered messages in stable oldest-first order with a cursor and read/acknowledged state. Reading marks items read by default; pass `mark_read=false` to inspect without changing state.
- `acknowledge_message` explicitly acknowledges one delivered item owned by the caller.
- `reply_to_message` is the only reply edge. It preserves the original conversation ID and sets the original message as parent, but otherwise creates an independent queued delivery.
- `get_message_status` is visible only to the authenticated sender or recipient and reports `queued`, `running`, `delivered`, `failed`, `expired`, `dead_letter`, or `unknown`.

## Retry, expiry, and dead letters

Transient transport/busy failures use bounded exponential backoff and reconciliation. A message that exceeds its TTL becomes `expired` without starting a new turn. Asynchronous work that exhausts transient retry attempts becomes `dead_letter`; non-transient validation or recipient-turn failures become `failed`. `codex-inter-agent health` reports unfinished and asynchronous failure/dead-letter counts.

Retry a failed logical operation only with an intentional new tool call. Reuse the same idempotency key when retrying an invocation whose acceptance is uncertain.

## Anti-loop invariant

Assistant output is never interpreted as a reply, notice, tool invocation, or new network edge. Every edge requires one authenticated model tool call (`send_message` or `reply_to_message`) or a human administrative action. Consequently, two agents cannot enter an automatic response loop through this feature.

## Examples

```text
send_message(recipient="legal", message="Review this when idle", kind="request", idempotency_key="review-42")
get_message_status(message_id="msg_...")
read_inbox(limit=20)
acknowledge_message(message_id="msg_...")
reply_to_message(message_id="msg_...", message="Review complete")
```
