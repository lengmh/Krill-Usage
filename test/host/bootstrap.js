"use strict";

// Test-only entry point of the disposable staged extension. VS Code calls this
// activate with a REAL ExtensionContext. All behavior is delegated to the
// byte-identical production extension; only dialogs and HTTPS are substituted.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const vscode = require("vscode");
const { SyntheticTransport } = require("./transport");

let harness;
let production;

async function activate(context) {
  assert.equal(process.env.KRILL_HOST_TEST, "1", "Use test/run-host.js to isolate the host");
  assert.equal(harness, undefined, "The host must activate the extension only once");
  const sourceDirectory = path.resolve(__dirname, "../../src");
  const constants = require(path.join(sourceDirectory, "constants"));
  const { API_URL, LOGIN_URL, SECRET_KEY } = constants;
  const transport = new SyntheticTransport(API_URL, LOGIN_URL);
  const inputs = [];
  const confirmations = [];
  const messages = [];
  const prompts = {
    inputs, confirmations, messages,
    assertIdle() {
      assert.equal(inputs.length, 0, "Unused synthetic input");
      assert.equal(confirmations.length, 0, "Unused synthetic confirmation");
    }
  };
  const windowOverrides = {
      async showInputBox(options) {
        assert.ok(inputs.length, "Unexpected input dialog");
        const input = inputs.shift();
        if (input && typeof input === "object") {
          assert.equal(options.password === true, input.masked, "Input masking must match the field");
          assert.match(options.title, input.title);
          return input.value;
        }
        assert.equal(options.password, true, "JWT input must be masked");
        return input;
      },
      async showWarningMessage(message, ...arguments_) {
        if (arguments_[0]?.modal) {
          assert.ok(confirmations.length, "Unexpected confirmation dialog");
          const answer = confirmations.shift();
          assert.ok(arguments_.slice(1).includes(answer), "Confirmation must be offered by production");
          return answer;
        }
        messages.push({ kind: "warning", message });
        return undefined;
      },
      async showInformationMessage(message) {
        messages.push({ kind: "information", message });
        return undefined;
      },
      async showErrorMessage(message) {
        messages.push({ kind: "error", message });
        return undefined;
      }
  };
  // Inherit APIs lazily. Spreading vscode/window would evaluate every getter,
  // including proposed APIs which reject access in an ordinary extension.
  const windowFacade = Object.create(vscode.window, Object.getOwnPropertyDescriptors(windowOverrides));
  const facade = Object.create(vscode, {
    window: { value: windowFacade, enumerable: true }
  });

  harness = { context, transport, prompts, constants, secretKey: SECRET_KEY, service: null, controller: null };
  const originalLoad = Module._load;
  const scopedLoad = function (request, parent, isMain) {
    if (parent?.filename.startsWith(sourceDirectory + path.sep)) {
      if (request === "vscode") return facade;
      if (["node:https", "https", "node:http", "http"].includes(request)) return transport.https;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const restoreLoader = () => {
    if (Module._load === scopedLoad) Module._load = originalLoad;
  };
  let serviceModule, statusModule, OriginalService, OriginalController;
  try {
    // Intercept ONLY imports issued by this staged extension's production src.
    // The host and the tests themselves retain their real vscode/network APIs.
    // Keep the guard installed until disposal, including any lazy imports.
    Module._load = scopedLoad;
    serviceModule = require(path.join(sourceDirectory, "service"));
    statusModule = require(path.join(sourceDirectory, "statusBar"));
    OriginalService = serviceModule.KrillUsageService;
    OriginalController = statusModule.StatusBarController;
    // Constructor observers do not override any production methods or state.
    serviceModule.KrillUsageService = class extends OriginalService {
      constructor(realContext) { super(realContext); harness.service = this; }
    };
    statusModule.StatusBarController = class extends OriginalController {
      constructor(service) { super(service); harness.controller = this; }
    };
    production = require(path.join(sourceDirectory, "extension"));
  } catch (error) {
    restoreLoader();
    throw error;
  } finally {
    if (serviceModule && OriginalService) serviceModule.KrillUsageService = OriginalService;
    if (statusModule && OriginalController) statusModule.StatusBarController = OriginalController;
  }
  context.subscriptions.push({ dispose: restoreLoader });

  // A fresh profile must have no Krill secret. Never read the user's profile.
  for (const key of [SECRET_KEY, constants.AUTH_SECRET_KEY, constants.EMAIL_SECRET_KEY, constants.PASSWORD_SECRET_KEY]) {
    assert.equal(await context.secrets.get(key), undefined, "Isolated profile must start with no Krill secrets");
  }
  await production.activate(context);
  return harness;
}

function deactivate() {
  harness?.transport.dispose();
  production?.deactivate();
}

module.exports = { activate, deactivate };
