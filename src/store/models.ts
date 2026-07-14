export type AgentStatus = "active" | "paused" | "superseded" | "disabled";
export type AgentOwnerMode = "bridge-managed" | "unverified";

export interface AgentOwnerBinding {
  readonly ownerMode: "bridge-managed";
  readonly installationId: string;
  readonly databaseId: string;
  readonly protocolVersion: string;
}
export type MessageStatus =
  "queued" | "dispatching" | "running" | "completed" | "failed" | "dead_letter";
export type MessageKind = "request" | "reply" | "notice";

export interface AgentRecord {
  readonly agentId: string;
  readonly displayName: string;
  readonly activeThreadId: string;
  readonly generation: number;
  readonly workspace: string;
  readonly acceptsMessages: boolean;
  readonly status: AgentStatus;
  readonly ownerMode: AgentOwnerMode;
  readonly ownerInstallationId: string | null;
  readonly ownerDatabaseId: string | null;
  readonly ownerProtocolVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageRecord {
  readonly messageId: string;
  readonly conversationId: string;
  readonly parentMessageId: string | null;
  readonly senderAgentId: string;
  readonly recipientAgentId: string;
  readonly recipientGeneration: number;
  readonly kind: MessageKind;
  readonly body: string;
  readonly expectsReply: boolean;
  readonly hopCount: number;
  readonly callChain: readonly string[];
  readonly status: MessageStatus;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly completedAt: string | null;
  readonly targetThreadId: string | null;
  readonly targetTurnId: string | null;
  readonly replyBody: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly attemptCount: number;
  readonly idempotencyKey: string | null;
  readonly nextAttemptAt: string | null;
  readonly expiresAt: string | null;
  readonly inboxReadAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly groupId: string | null;
  readonly groupMessageId: string | null;
}

export const MESSAGE_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ["dispatching", "failed", "dead_letter"],
  dispatching: ["queued", "running", "failed", "dead_letter"],
  running: ["queued", "completed", "failed", "dead_letter"],
  completed: [],
  failed: [],
  dead_letter: [],
};

export function assertMessageTransition(from: MessageStatus, to: MessageStatus): void {
  if (!MESSAGE_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid message status transition: ${from} -> ${to}`);
  }
}
