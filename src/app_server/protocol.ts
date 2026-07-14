export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(object: JsonObject, key: string, context: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return value;
}

export function optionalObject(object: JsonObject, key: string): JsonObject | null {
  const value = object[key];
  return isJsonObject(value) ? value : null;
}
