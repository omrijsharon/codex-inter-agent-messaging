# MVP Real-Thread Exchange Evidence

Completed: 2026-07-14 18:40:43 +03:00 (Asia/Jerusalem)

## Topology

- Sender agent: `inter-agent`
- Recipient agent: `prepare-inter-agent-thread`
- Existing recipient thread: `019f6082-fd66-7da2-aa9f-b6461c2c486d`
- Shared owner: bridge-managed capability-token-authenticated loopback app-server
- UI automation, copy/paste, session-file edits, and coordinator agents: none

## Correlation evidence

- Message ID: `msg_d0519b34-5ac0-40d5-a330-96c035c427c0`
- Conversation ID: `production-m8-runtime-smoke`
- Recipient turn ID: `019f6146-cdc7-7092-ab78-d9ccd8a3c6be`
- Runtime duration: 188.1 seconds
- Persisted attempt count: 1
- Duplicate invocation with idempotency key `production-m8-named-pair`: returned the same message ID and created no second turn

## Sanitized transcript

Sender request body:

> In one short clause, state the purpose your user assigned to this thread before this message. On the final line, write exactly MVP_ACCEPTANCE_OK. Do not call tools.

Authoritative recipient final reply:

> Inter-agent test thread awaiting repository messages.  
> MVP_ACCEPTANCE_OK

The purpose statement was available from the recipient's pre-existing thread context and was not supplied as an answer in the request. The production service persisted the final reply before returning it to the sender.
