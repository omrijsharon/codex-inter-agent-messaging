# Group Messaging

Group messaging is explicit one-to-many asynchronous fan-out. It does not create a group coordinator or automatically collect assistant output.

## Identity, membership, and roles

- A group has a stable `group_id`, display name, owner agent, and `active`, `paused`, or terminal `deleted` status.
- The owner and members are stable registered agent IDs. Only active members can list or send to a group.
- Local operator commands create groups and change membership. The owner cannot be removed; a deleted group cannot be resumed.
- Every group message stores an immutable snapshot of active membership. Adding or removing a member after acceptance does not change in-flight recipients or historical visibility.

```powershell
codex-inter-agent group create --group-id reviewers --display-name "Reviewers" --owner-agent-id cfo
codex-inter-agent group add reviewers legal
codex-inter-agent group show reviewers
codex-inter-agent group pause reviewers
codex-inter-agent group resume reviewers
codex-inter-agent group remove reviewers legal
codex-inter-agent group delete reviewers
```

## Delivery semantics

`send_group_message` creates one immutable group message and one independent asynchronous delivery per snapshotted recipient other than the sender. All deliveries share a conversation ID but receive distinct message, target-thread, and target-turn IDs. Each uses its recipient's FIFO queue, lease, retry, TTL, and audit lifecycle.

Pairwise sender-to-recipient ACLs are evaluated before acceptance. Message size, per-recipient queue depth, and `BRIDGE_MAX_GROUP_FANOUT` (default 20) are enforced atomically; a validation failure creates no partial group message.

`get_group_message_status` reports every recipient independently and summarizes `queued`, `running`, `delivered`, `failed`, `expired`, and `dead_letter` counts. `retry_group_message` creates a new delivery only for requested failed/dead-letter recipients. A delivered recipient is never redelivered by group retry.

## Replies and synthesis

Recipient assistant output from the inbound group turn is discarded under the asynchronous anti-loop rule. A recipient must use `reply_to_message` on its own delivery message to create a visible reply.

`gather_group_replies` is available only to the original sender. It returns explicit reply bodies and always names `synthesizing_agent`; it never returns hidden reasoning, intermediate commentary, command output, or implicit assistant output. Any later synthesis is an ordinary action by that named caller, not an automatic network edge.

## Model-facing tools

```text
list_groups()
send_group_message(group_id="reviewers", message="Review independently", idempotency_key="review-42")
get_group_message_status(group_message_id="gmsg_...")
retry_group_message(group_message_id="gmsg_...", recipients=["legal"])
gather_group_replies(group_message_id="gmsg_...")
```

Visibility is limited to the original sender and agents present in the stored membership snapshot. Group administration is local-operator-only and is not exposed through MCP.
