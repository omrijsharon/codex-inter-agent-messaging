export const PEER_ENVELOPE_VERSION = "INTER_AGENT_MESSAGE_V1" as const;
export { buildPeerEnvelope } from "./envelope.js";
export { buildAsyncPeerEnvelope } from "./envelope.js";
export { MessagingError, MessagingService } from "./service.js";
export type { AskAgentInput, AskAgentResult, MessagingServiceOptions } from "./service.js";
export { DeliveryScheduler } from "./scheduler.js";
export type { DeliverySchedulerOptions } from "./scheduler.js";
export { AsyncMessagingService } from "./async_service.js";
export type {
  AsyncDeliveryStatus,
  AsyncMessageStatus,
  AsyncMessagingServiceOptions,
  InboxItem,
  SendMessageInput,
} from "./async_service.js";
export { GroupMessagingService } from "./group_service.js";
export type {
  GroupDeliveryStatus,
  GroupMessageStatus,
  GroupMessagingServiceOptions,
} from "./group_service.js";
