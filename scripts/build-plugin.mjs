import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-inter-agent-messaging");
const runtimeRoot = path.join(pluginRoot, "runtime");
function runNpm(arguments_, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, ...arguments_], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync("npm", arguments_, { cwd, stdio: "inherit" });
}

runNpm(["run", "build"], root);
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
await cp(path.join(root, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
await cp(path.join(root, "package-lock.json"), path.join(runtimeRoot, "package-lock.json"));

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const runtimePackage = {
  name: packageJson.name,
  version: packageJson.version,
  private: true,
  type: "module",
  engines: packageJson.engines,
  dependencies: packageJson.dependencies,
};
await writeFile(
  path.join(runtimeRoot, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
  "utf8",
);
runNpm(["install", "--omit=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"], runtimeRoot);
process.stdout.write(`Plugin runtime assembled at ${runtimeRoot}\n`);
