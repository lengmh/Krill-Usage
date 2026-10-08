"use strict";

// Runs in Node, not in the extension host. The disposable profile never sees
// the developer's installed extensions, settings, workspace, or credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { runTests } = require("@vscode/test-electron");
  const root = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "krill-host-test-"));
  const extension = path.join(temporary, "extension");
  const workspace = path.join(temporary, "workspace");
  try {
    fs.mkdirSync(extension, { recursive: true });
    fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
    fs.cpSync(path.join(root, "src"), path.join(extension, "src"), { recursive: true });
    fs.cpSync(path.join(root, "media"), path.join(extension, "media"), { recursive: true });
    fs.cpSync(path.join(__dirname, "host"), path.join(extension, "test", "host"), { recursive: true });

    // Only the staged entry point changes. Activation events, configuration,
    // command contributions, and every production source byte remain intact.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({
      ...manifest, main: "./test/host/bootstrap.js"
    }, null, 2));
    for (const name of fs.readdirSync(path.join(root, "src"))) {
      assert.deepEqual(fs.readFileSync(path.join(extension, "src", name)),
        fs.readFileSync(path.join(root, "src", name)), `${name} must be byte-identical`);
    }
    fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
      "krillUsage.refreshIntervalMinutes": 60
    }));

    await runTests({
      version: process.env.VSCODE_VERSION || "stable",
      extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(extension, "test", "host", "index.js"),
      extensionTestsEnv: {
        KRILL_HOST_TEST: "1",
        KRILL_HOST_EXTENSION_ID: `${manifest.publisher}.${manifest.name}`
      },
      launchArgs: [
        workspace,
        `--user-data-dir=${path.join(temporary, "profile")}`,
        `--extensions-dir=${path.join(temporary, "extensions")}`,
        "--disable-extensions",
        "--disable-gpu",
        "--password-store=basic"
      ]
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => {
  console.error("Krill VS Code extension-host tests failed:", error);
  process.exitCode = 1;
});
