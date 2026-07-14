import { EventEmitter } from "node:events";
import { isJsonObject, type JsonObject } from "./protocol.js";

export interface AppServerEvent {
  readonly sequence: number;
  readonly method: string;
  readonly params: JsonObject;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly callId?: string;
  readonly requestId?: string;
}

export interface EventRoute {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly callId?: string;
  readonly requestId?: string;
}

function stringField(object: JsonObject | null, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function identity(method: string, params: JsonObject, sequence: number): AppServerEvent {
  const turn = isJsonObject(params.turn) ? params.turn : null;
  const item = isJsonObject(params.item) ? params.item : null;
  const event: AppServerEvent = { sequence, method, params };
  const fields = {
    threadId: stringField(params, "threadId"),
    turnId: stringField(params, "turnId") ?? stringField(turn, "id"),
    itemId: stringField(params, "itemId") ?? stringField(item, "id"),
    callId: stringField(params, "callId") ?? stringField(item, "callId"),
    requestId: stringField(params, "requestId"),
  };
  return Object.assign(
    event,
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
  );
}

function matches(event: AppServerEvent, route: EventRoute): boolean {
  return (Object.keys(route) as Array<keyof EventRoute>).every(
    (key) => route[key] === undefined || event[key] === route[key],
  );
}

export class AppServerEventRouter extends EventEmitter {
  readonly #historyLimit: number;
  #sequence = 0;
  #history: AppServerEvent[] = [];

  constructor(historyLimit = 10_000) {
    super();
    this.#historyLimit = historyLimit;
  }

  get sequence(): number {
    return this.#sequence;
  }

  dispatch(method: string, params: JsonObject): AppServerEvent {
    const event = identity(method, params, ++this.#sequence);
    this.#history.push(event);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.emit("event", event);
    return event;
  }

  eventsSince(sequence: number, route: EventRoute = {}): AppServerEvent[] {
    return this.#history.filter((event) => event.sequence > sequence && matches(event, route));
  }

  subscribe(route: EventRoute, handler: (event: AppServerEvent) => void): () => void {
    const listener = (event: AppServerEvent): void => {
      if (matches(event, route)) handler(event);
    };
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
