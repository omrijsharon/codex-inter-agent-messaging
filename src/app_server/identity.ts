import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "../config/index.js";

export const INSTALLATION_ID_FILE = "installation.id";

export interface RuntimeIdentity {
  readonly installationId: string;
  readonly databaseId: string;
}

function validInstallationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function resolveRuntimeIdentity(config: BridgeConfig): Promise<RuntimeIdentity> {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.dataDirectory, 0o700).catch(() => undefined);
  const identityPath = path.join(config.dataDirectory, INSTALLATION_ID_FILE);
  let installationId: string;
  try {
    const handle = await open(identityPath, "wx", 0o600);
    installationId = randomUUID();
    try {
      await handle.writeFile(`${installationId}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    installationId = (await readFile(identityPath, "utf8")).trim();
  }
  if (!validInstallationId(installationId)) {
    throw new Error("bridge installation identity is invalid");
  }
  await chmod(identityPath, 0o600).catch(() => undefined);
  const databaseId = createHash("sha256")
    .update(path.resolve(config.databasePath).toLowerCase(), "utf8")
    .digest("hex");
  return { installationId, databaseId };
}
