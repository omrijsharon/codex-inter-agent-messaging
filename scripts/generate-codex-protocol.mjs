import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertInsideRepository,
  codexVersion,
  generatedRoot,
  protocolDigest,
  runCodex,
} from "./protocol-utils.mjs";

const temporaryRoot = path.join(generatedRoot, `.tmp-${randomUUID()}`);
assertInsideRepository(temporaryRoot);

try {
  await mkdir(temporaryRoot, { recursive: true });
  const jsonOutput = path.join(temporaryRoot, "json-schema");
  const typeScriptOutput = path.join(temporaryRoot, "typescript");
  runCodex(["app-server", "generate-json-schema", "--experimental", "--out", jsonOutput]);
  runCodex(["app-server", "generate-ts", "--experimental", "--out", typeScriptOutput]);

  for (const name of ["json-schema", "typescript"]) {
    const destination = path.join(generatedRoot, name);
    assertInsideRepository(destination);
    await rm(destination, { recursive: true, force: true });
    await rename(path.join(temporaryRoot, name), destination);
  }

  const digest = await protocolDigest();
  const manifest = { codexVersion: codexVersion(), ...digest };
  await writeFile(
    path.join(generatedRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
