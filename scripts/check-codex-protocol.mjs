import { readFile } from "node:fs/promises";
import path from "node:path";
import { codexVersion, generatedRoot, protocolDigest } from "./protocol-utils.mjs";

const manifestPath = path.join(generatedRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const installedVersion = codexVersion();
if (manifest.codexVersion !== installedVersion) {
  throw new Error(
    `Codex protocol drift: generated for ${manifest.codexVersion}, installed ${installedVersion}. Run npm run schema:generate.`,
  );
}

const actual = await protocolDigest();
if (manifest.fileCount !== actual.fileCount || manifest.sha256 !== actual.sha256) {
  throw new Error("generated Codex protocol files differ from manifest; regenerate them");
}

process.stdout.write(
  `Codex protocol verified: ${installedVersion}, ${actual.fileCount} files, ${actual.sha256}\n`,
);
