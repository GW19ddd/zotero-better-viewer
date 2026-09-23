import {
  registerAutoFit,
  registerAutoFitPrefObservers,
  runAutoFitOnLoad,
  unregisterAutoFit,
  unregisterAutoFitPrefObservers,
} from "./modules/auto-fit";
import {
  registerColumnWidthSync,
  unregisterColumnWidthSync,
} from "./modules/column-width-sync";
import {
  buildPreferencePane,
  registerPreferencePanel,
} from "./modules/preference";
import {
  registerStyleSheet,
  unregisterStyleSheet,
} from "./modules/style-sheet";
import {
  registerWrapColumns,
  registerWrapPrefObservers,
  unregisterWrapColumns,
  unregisterWrapPrefObservers,
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

  try {
    await registerPreferencePanel();
  } catch (e) {
    ztoolkit.log("registerPreferencePanel failed", e);
  }

  // Keep every window's wrapping CSS in sync with the prefs, whoever changes
  // them (preferences pane, another window, about:config).
  registerWrapPrefObservers();

  try {
    registerAutoFitPrefObservers();
  } catch (e) {
    ztoolkit.log("registerAutoFitPrefObservers failed", e);
  }

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

  // "Auto fit" (fit column widths / shrink fonts) menu + CSS
  try {
    registerAutoFit(win);
  } catch (e) {
    ztoolkit.log("registerAutoFit failed", e);
  }

  try {
    runAutoFitOnLoad(win);
  } catch (e) {
    ztoolkit.log("runAutoFitOnLoad failed", e);
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

  try {
    unregisterAutoFit(win);
  } catch (e) {
    ztoolkit.log("unregisterAutoFit failed", e);
  }
}

async function onShutdown() {
  unregisterWrapPrefObservers();

  try {
    unregisterAutoFitPrefObservers();
  } catch (e) {
    ztoolkit.log("unregisterAutoFitPrefObservers failed", e);
  }

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

/**
 * Dispatched by `preferences.xhtml` (`onload` / `onunload`). The pane is loaded
 * as a fragment inside Zotero's preferences window, so everything about its
 * content lives here, in the addon bundle.
 */
function onPrefsEvent(
  type: "load" | "unload",
  data: { window: Window; [key: string]: unknown },
): void {
  if (type === "load") {
    buildPreferencePane(data.window);
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
