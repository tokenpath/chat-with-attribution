import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const parts = version?.split(".") || [];
const valid =
  parts.length >= 1 &&
  parts.length <= 4 &&
  parts.every(
    (part) =>
      /^(0|[1-9]\d*)$/.test(part) &&
      Number(part) >= 0 &&
      Number(part) <= 65535
  );

if (!valid) {
  console.error(
    "Usage: npm run version:set -- <1-4 numeric components, each 0-65535>"
  );
  process.exit(1);
}

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(join(extensionRoot, relativePath), "utf8")
  );
}

async function writeJson(relativePath, value) {
  await writeFile(
    join(extensionRoot, relativePath),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

const manifest = await readJson("manifest.json");
const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");

manifest.version = version;
packageJson.version = version;
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}

await Promise.all([
  writeJson("manifest.json", manifest),
  writeJson("package.json", packageJson),
  writeJson("package-lock.json", packageLock),
]);

console.log(`Set extension version to ${version}`);
