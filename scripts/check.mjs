import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// 拡張の実行ファイルとマニフェストが参照するファイルを確認する。
const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const extensionDirectory = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionDirectory), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
assert.equal(manifest.permissions.includes("history"), false);
const requiredFiles = new Set([
  manifest.background.service_worker, manifest.action.default_popup, "popup.css", "popup.js", "fonts/NotoSerif.ttf", "fonts/OFL.txt",
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(function listContentFiles(script) {
    // 各コンテンツスクリプトが参照するファイルを列挙する。
    return script.js;
  })
]);
for (const relativePath of requiredFiles) {
  await access(new URL(relativePath, extensionDirectory));
  if (!relativePath.endsWith(".js")) continue;
  const checked = spawnSync(process.execPath, ["--check", `extension/${relativePath}`], {
    cwd: projectDirectory, encoding: "utf8", windowsHide: true
  });
  assert.equal(checked.status, 0, checked.stderr);
}
console.log(`Manifestと${requiredFiles.size}ファイルの参照・JavaScript構文を確認しました。`);
