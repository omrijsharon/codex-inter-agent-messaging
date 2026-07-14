import { rm } from "node:fs/promises";
import path from "node:path";
import { assertInsideRepository, repositoryRoot } from "./protocol-utils.mjs";

for (const name of ["coverage", "dist"]) {
  const target = path.join(repositoryRoot, name);
  assertInsideRepository(target);
  await rm(target, { recursive: true, force: true });
}
