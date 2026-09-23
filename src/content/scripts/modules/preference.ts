import { config } from "../../../../package.json";
import { getString } from "../utils/locale";
import {
  columnLabel,
  getVisibleColumns,
  getWrapKeys,
  getWrapRowTypes,
  saveWrapKeys,
  saveWrapRowTypes,
  WRAP_ROW_TYPES,
  type WrapRowType,
} from "./wrap-columns";

/** IDs referenced from `preferences.xhtml`. */
const ROW_LIST_ID = `${config.addonRef}-wrap-rows-list`;
const COLUMN_LIST_ID = `${config.addonRef}-wrap-columns-list`;

const ROW_LABEL_KEYS: Record<WrapRowType, string> = {
  regular: "pref-wrap-rows-regular",
  note: "pref-wrap-rows-note",
  attachment: "pref-wrap-rows-attachment",
  annotation: "pref-wrap-rows-annotation",
};

export function registerPreferencePanel() {
  try {
    return Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: `${rootURI}content/preferences.xhtml`,
      label: getString("prefs-title"),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    });
  } catch (e) {
    log("registerPreferencePanel failed", e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pane content
// ---------------------------------------------------------------------------

/**
 * Fill the dynamic parts of the pane. Called from the `onload` handler of the
 * pane XHTML — the static markup is already inserted and localized at that
 * point.
 *
 * Nothing here may throw: a half built pane is worse than a missing option, so
 * the two sections are guarded individually.
 */
export function buildPreferencePane(win: Window): void {
  const doc = win.document;
  try {
    buildRowCheckboxes(doc);
  } catch (e) {
    log("failed to build row checkboxes", e);
  }
  try {
    buildColumnCheckboxes(win);
  } catch (e) {
    log("failed to build column checkboxes", e);
  }
}

/**
 * The row list is static (four known kinds), only its checked state comes from
 * the pref.
 */
function buildRowCheckboxes(doc: Document): void {
  const container = doc.getElementById(ROW_LIST_ID);
  if (!container) {
    log("row list container not found");
    return;
  }
  clear(container);

  const selected = new Set(getWrapRowTypes());
  for (const rowType of WRAP_ROW_TYPES) {
    container.append(
      createCheckbox(
        doc,
        getString(ROW_LABEL_KEYS[rowType]),
        selected.has(rowType),
        (checked) => {
          const types = new Set(getWrapRowTypes());
          if (checked) {
            types.add(rowType);
          } else {
            types.delete(rowType);
          }
          saveWrapRowTypes(Array.from(types));
        },
      ),
    );
  }
}

/**
 * The column list mirrors the columns currently visible in the item tree, so it
 * has to be read from whatever main window is available. Degrades to a hint
 * when no tree can be reached.
 */
function buildColumnCheckboxes(win: Window): void {
  const doc = win.document;
  const container = doc.getElementById(COLUMN_LIST_ID);
  if (!container) {
    log("column list container not found");
    return;
  }
  clear(container);

  let columns: ReturnType<typeof getVisibleColumns> = [];
  try {
    columns = getVisibleColumns(win);
  } catch (e) {
    log("failed to read visible columns", e);
  }

  if (!columns.length) {
    container.append(
      createHint(doc, getString("pref-wrap-columns-unavailable")),
    );
    return;
  }

  const selected = new Set(getWrapKeys());
  for (const column of columns) {
    const dataKey = column.dataKey;
    container.append(
      createCheckbox(
        doc,
        columnLabel(column),
        selected.has(dataKey),
        (checked) => {
          const keys = new Set(getWrapKeys());
          if (checked) {
            keys.add(dataKey);
          } else {
            keys.delete(dataKey);
          }
          saveWrapKeys(Array.from(keys));
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * A plain XUL checkbox — the same widget Zotero's own panes use, so it inherits
 * the platform styling. `wrapRows`/`wrapColumns` hold comma separated lists
 * rather than booleans, so Zotero's `preference=` binding cannot be used here.
 */
function createCheckbox(
  doc: Document,
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): Element {
  const checkbox = doc.createXULElement("checkbox") as Element & {
    checked: boolean;
  };
  checkbox.setAttribute("label", label);
  if (checked) {
    checkbox.setAttribute("checked", "true");
  }
  checkbox.addEventListener("command", () => {
    onChange(checkbox.checked);
  });
  return checkbox;
}

function createHint(doc: Document, text: string): Element {
  const hint = doc.createElement("p");
  hint.className = `${config.addonRef}-pref-hint`;
  hint.textContent = text;
  return hint;
}

function clear(element: Element): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function log(...args: unknown[]): void {
  try {
    ztoolkit.log("[preferences]", ...args);
  } catch {
    /* ztoolkit not ready — never break the plugin because of logging */
  }
}
