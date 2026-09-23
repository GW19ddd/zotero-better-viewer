import {
  registerColumnWidthSync,
  unregisterColumnWidthSync,
} from "./modules/column-width-sync";
import {
  registerStyleSheet,
  unregisterStyleSheet,
} from "./modules/style-sheet";
import {
  registerWrapColumns,
  unregisterWrapColumns,
} from "./modules/wrap-columns";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // registerPreferencePanel();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  registerStyleSheet(win);

  // Column width sync patches internal Zotero APIs — never let it break loading
  try {
    registerColumnWidthSync(win);
  } catch (e) {
    ztoolkit.log("registerColumnWidthSync failed", e);
  }

  // Per-column wrapping (dynamic CSS + item context menu)
  try {
    registerWrapColumns(win);
  } catch (e) {
    ztoolkit.log("registerWrapColumns failed", e);
  }
}

function onMainWindowUnload(win: Window): void {
  ztoolkit.unregisterAll();
  unregisterStyleSheet(win);

  try {
    unregisterColumnWidthSync(win);
  } catch (e) {
    ztoolkit.log("unregisterColumnWidthSync failed", e);
  }

  try {
    unregisterWrapColumns(win);
  } catch (e) {
    ztoolkit.log("unregisterWrapColumns failed", e);
  }
}

async function onShutdown() {
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowUnload(win)),
  );
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
