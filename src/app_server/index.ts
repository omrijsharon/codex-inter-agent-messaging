export interface ProtocolManifest {
  readonly codexVersion: string;
  readonly fileCount: number;
  readonly sha256: string;
}

export { SharedAppServerHost } from "./host.js";
export { SHARED_OWNER_CONNECTION_FILE } from "./runtime.js";
export {
  ensureHostRunning,
  getHostStatus,
  HostBootstrapError,
  restartManagedHost,
  stopManagedHost,
} from "./bootstrap.js";
export type { HostBootstrapErrorCode, HostStatus, ManagedHostConnection } from "./bootstrap.js";
export type { SharedAppServerConnection, SharedAppServerHostOptions } from "./host.js";
export { JsonLineDecoder, ProtocolFrameError } from "./json_line_decoder.js";
export type { ProtocolFrameErrorCode } from "./json_line_decoder.js";
export { JsonRpcRequestIdAllocator, SerializedJsonWriter } from "./json_rpc_writer.js";
export type { JsonRpcRequestId, SerializedSend } from "./json_rpc_writer.js";
export { AppServerClient, AppServerRequestError } from "./client.js";
export type { AppServerClientOptions, ServerRequestHandler } from "./client.js";
export { AppServerEventRouter } from "./event_router.js";
export type { AppServerEvent, EventRoute } from "./event_router.js";
export {
  collectTurn,
  extractAuthoritativeFinalReply,
  TurnCollectionError,
  TurnOutcomeError,
} from "./turn_collector.js";
export type { CollectedTurn } from "./turn_collector.js";
