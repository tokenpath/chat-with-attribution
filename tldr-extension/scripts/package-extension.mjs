import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(extensionRoot, "manifest.json"), "utf8")
);
const archiveName =
  `tokenpath-chat-with-attribution-${manifest.version}.zip`;
const distDir = join(extensionRoot, "dist");
const archivePath = join(distDir, archiveName);
const stagingDir = await mkdtemp(join(tmpdir(), "tokenpath-extension-"));

const runtimeFiles = [
  "background.js",
  "content.css",
  "content.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "sidepanel/panel.css",
  "sidepanel/panel.html",
  "sidepanel/panel.js",
  "sidepanel/panel-logic.js",
  "sidepanel/tokenpath.js",
];

try {
  for (const relativePath of runtimeFiles) {
    const destination = join(stagingDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(extensionRoot, relativePath), destination);
  }

  // Development endpoints stay available to unpacked local builds, but the
  // Web Store package requests access only to TokenPath's production API.
  manifest.host_permissions = manifest.host_permissions.filter(
    (permission) => permission === "https://api.tokenpath.ai/*"
  );
  await writeFile(
    join(stagingDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  await mkdir(distDir, { recursive: true });
  await rm(archivePath, { force: true });
  const result = spawnSync("zip", ["-q", "-r", archivePath, "."], {
    cwd: stagingDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "zip failed");
  }
  const digest = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  console.log(`Created dist/${basename(archivePath)}`);
  console.log(`SHA-256 ${digest}`);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
