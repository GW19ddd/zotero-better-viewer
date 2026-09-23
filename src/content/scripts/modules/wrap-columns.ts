/**
 * Per-column / per-row-type text wrapping for the item tree.
 *
 * Zotero clips every cell to a single line (`white-space: nowrap` +
 * `text-overflow: ellipsis`). This module lets the user pick — from the
 * preferences pane or the item context menu — which columns should wrap, and
 * which *kinds* of rows should be affected; everything else keeps the native
 * one-line ellipsis behaviour.
 *
 * Implementation notes (verified against Zotero 10.0.3 / omni.ja):
 * - Every rendered cell carries its dataKey as a class
 *   (`<span class="cell title title-item-tree-main primary">`), so a plain CSS
 *   class selector is enough — no DOM patching, and column reordering needs no
 *   extra handling. Custom column dataKeys may contain `@`/`.`, hence
 *   `CSS.escape`.
 * - The ellipsis lives on two levels: the outer `.cell` and, for the primary
 *   column, the inner `.cell-text`. Both have to be reset or the title stays
 *   clipped.
 * - Rows carry no type class (only the toggles `annotation-row`,
 *   `library-header-row` and `spacer-row`), but the first cell of every row
 *   holds the type icon with a `data-item-type` attribute
 *   (`<span class="icon icon-css cell-icon item-icon" data-item-type="note">`),
 *   which is enough for a `:has()` based selector. `regular` items can only be
 *   described negatively (everything that is neither a note nor an
 *   attachment).
 * - Column selection is stored as a comma separated list of dataKeys in the
 *   `wrapColumns` pref; row selection as a comma separated list of row types
 *   in `wrapRows`. The CSS is regenerated on every change so it applies
 *   instantly.
 */

import { config } from "../../../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  unregisterDynamicStyleSheet,
  updateDynamicStyleSheet,
} from "./style-sheet";

const MENU_ID = `${config.addonRef}-itemmenu-wrap-columns`;
const MENU_POPUP_ID = `${config.addonRef}-itemmenu-wrap-columns-popup`;

/**
 * Row kinds the user can enable wrapping for. Item ("regular") rows can only
 * be matched negatively — everything that has a type icon which is neither a
 * note nor an attachment.
 */
export type WrapRowType = "regular" | "note" | "attachment" | "annotation";

/** Stable UI order — also used when building the preferences pane. */
export const WRAP_ROW_TYPES: readonly WrapRowType[] = [
  "regular",
  "note",
  "attachment",
  "annotation",
];

const PREFS_PREFIX = config.prefsPrefix;

/** Rows that must never wrap, regardless of the row type selection. */
const ROW_EXCLUSIONS = ":not(.library-header-row):not(.spacer-row)";

/** First column of a row holds `<span class="cell-icon" data-item-type>`. */
const FIRST_COLUMN_ICON = "> .cell.first-column > .cell-icon";

const ROW_MATCHERS: Record<WrapRowType, string> = {
  regular: `${ROW_EXCLUSIONS}:has(${FIRST_COLUMN_ICON}[data-item-type]:not([data-item-type="note"]):not([data-item-type^="attachment"]))`,
  note: `${ROW_EXCLUSIONS}:has(${FIRST_COLUMN_ICON}[data-item-type="note"])`,
  attachment: `${ROW_EXCLUSIONS}:has(${FIRST_COLUMN_ICON}[data-item-type^="attachment"])`,
  // Annotation rows are identified by a class on the row itself.
  annotation: `.annotation-row${ROW_EXCLUSIONS}`,
};

/**
 * Two levels are targeted on purpose: `.cell` (outer) and `.cell-text`
 * (inner — only the primary column has one, but the rule is harmless
 * elsewhere).
 */
const WRAP_DECLARATIONS = [
  "white-space: normal !important",
  "overflow: visible !important",
  "text-overflow: clip !important",
  "max-height: none !important",
  "overflow-wrap: break-word !important",
];

export interface ItemTreeColumn {
  dataKey: string;
  label?: string;
  ordinal?: number;
  hidden?: boolean;
}

interface VirtualizedTableLike {
  _getVisibleColumns?: () => ItemTreeColumn[];
}

/** Windows the feature is currently registered for. */
const windows = new Set<Window>();

/** Handles returned by `Zotero.Prefs.registerObserver`. */
let prefObservers: symbol[] = [];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWrapColumns(win: Window): boolean {
  if (windows.has(win)) {
    unregisterWrapColumns(win);
  }
  windows.add(win);

  applyWrapCSS(win);
  registerMenu(win);
  return true;
}

export function unregisterWrapColumns(win: Window): void {
  windows.delete(win);
  win.document.getElementById(MENU_ID)?.remove();
  unregisterDynamicStyleSheet(win);
}

/**
 * Watch the wrapping prefs so edits made from anywhere (preferences pane,
 * another window, about:config) repaint every open item tree immediately.
 * Called once per plugin lifetime.
 */
export function registerWrapPrefObservers(): void {
  if (prefObservers.length) return;
  for (const key of ["wrapColumns", "wrapRows"]) {
    try {
      prefObservers.push(
        Zotero.Prefs.registerObserver(
          `${PREFS_PREFIX}.${key}`,
          () => applyWrapCSSToAllWindows(),
          true,
        ),
      );
    } catch (e) {
      log("failed to observe pref", key, e);
    }
  }
}

export function unregisterWrapPrefObservers(): void {
  for (const handle of prefObservers) {
    try {
      Zotero.Prefs.unregisterObserver(handle);
    } catch (e) {
      log("failed to unregister pref observer", e);
    }
  }
  prefObservers = [];
}

/** Rebuild and re-apply the wrapping stylesheet in every known window. */
export function applyWrapCSSToAllWindows(): void {
  for (const win of windows) {
    applyWrapCSS(win);
  }
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function getWrapKeys(): string[] {
  return parseList(getPref("wrapColumns"));
}

export function saveWrapKeys(keys: string[]): void {
  setPref("wrapColumns", joinList(keys));
  applyWrapCSSToAllWindows();
}

/** Selected row types, defaulting to regular items only. */
export function getWrapRowTypes(): WrapRowType[] {
  return parseList(getPref("wrapRows")).filter(isWrapRowType);
}

export function saveWrapRowTypes(types: string[]): void {
  setPref("wrapRows", joinList(types.filter(isWrapRowType)));
  applyWrapCSSToAllWindows();
}

function toggleKey(dataKey: string): void {
  const keys = new Set(getWrapKeys());
  if (keys.has(dataKey)) {
    keys.delete(dataKey);
  } else {
    keys.add(dataKey);
  }
  saveWrapKeys(Array.from(keys));
}

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function joinList(values: string[]): string {
  return Array.from(new Set(values)).join(",");
}

function isWrapRowType(value: string): value is WrapRowType {
  return (WRAP_ROW_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Wrapping rules for the given `dataKeys`, limited to the rows matching
 * `rowTypes`. An empty list on either side yields an empty stylesheet, i.e.
 * Zotero's default single-line ellipsis everywhere.
 *
 * One rule block is emitted per row type so that a selector the browser cannot
 * parse (e.g. `:has()` on an old Gecko) only disables that row type instead of
 * the whole stylesheet.
 */
export function buildWrapCSS(
  dataKeys: string[],
  rowTypes: WrapRowType[] | string[],
): string {
  if (!dataKeys.length) return "";

  // Scoped to the item tree so other virtualized tables are untouched.
  const cells: string[] = [];
  for (const dataKey of dataKeys) {
    const escaped = escapeCSSKey(dataKey);
    cells.push(` .cell.${escaped}`);
    cells.push(` .cell.${escaped} .cell-text`);
  }

  const rules: string[] = [];
  for (const rowType of rowTypes) {
    const matcher = ROW_MATCHERS[rowType as WrapRowType];
    if (!matcher) continue;
    const row = `#zotero-items-tree .virtualized-table .row${matcher}`;
    const selectors = cells.map((cell) => `${row}${cell}`);
    rules.push(
      `${selectors.join(",\n")} {\n  ${WRAP_DECLARATIONS.join(";\n  ")};\n}\n`,
    );
  }
  return rules.join("");
}

function escapeCSSKey(dataKey: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(dataKey);
  }
  // `CSS` is not necessarily reachable from the bootstrap sandbox.
  return dataKey.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function applyWrapCSS(win: Window): void {
  updateDynamicStyleSheet(win, buildWrapCSS(getWrapKeys(), getWrapRowTypes()));
}

// ---------------------------------------------------------------------------
// Item context menu
// ---------------------------------------------------------------------------

function registerMenu(win: Window): void {
  const doc = win.document;
  const itemMenu = doc.querySelector(
    "#zotero-itemmenu",
  ) as unknown as XUL.MenuPopup | null;
  if (!itemMenu) {
    log("item context menu (#zotero-itemmenu) not found");
    return;
  }

  ztoolkit.Menu.register(itemMenu, {
    tag: "menu",
    id: MENU_ID,
    label: getString("itemmenu-wrap-columns-label"),
    popupId: MENU_POPUP_ID,
    children: [],
  });

  const subPopup = doc.getElementById(MENU_POPUP_ID);
  if (!subPopup) {
    log("sub menu popup was not created");
    return;
  }
  // `onShowing` is only wired up for menuitem/menuseparator by the toolkit,
  // so the sub menu listens for itself.
  subPopup.addEventListener("popupshowing", () => {
    try {
      rebuildSubMenu(win, subPopup);
    } catch (e) {
      log("failed to rebuild wrap column menu", e);
    }
  });
}

/**
 * Rebuild the whole list on every opening: the visible column set changes
 * (columns shown/hidden, custom columns added, different library type) and
 * `checked` is only written when an element is created.
 */
function rebuildSubMenu(win: Window, subPopup: Element): void {
  while (subPopup.firstChild) {
    subPopup.removeChild(subPopup.firstChild);
  }

  const columns = getVisibleColumns(win);
  if (!columns.length) {
    subPopup.appendChild(
      createMenuItem(win, getString("itemmenu-wrap-columns-empty-label"), {
        checked: false,
        disabled: true,
      }),
    );
    return;
  }

  const selected = new Set(getWrapKeys());
  for (const column of columns) {
    subPopup.appendChild(
      createMenuItem(win, columnLabel(column), {
        checked: selected.has(column.dataKey),
        disabled: false,
        command: () => toggleKey(column.dataKey),
      }),
    );
  }
}

function createMenuItem(
  win: Window,
  label: string,
  options: {
    checked: boolean;
    disabled: boolean;
    command?: () => void;
  },
): Element {
  const item = ztoolkit.UI.createElement(win.document, "menuitem", {
    attributes: {
      type: "checkbox",
      label,
      checked: options.checked ? "true" : "false",
    },
    listeners: options.command
      ? [{ type: "command", listener: options.command }]
      : undefined,
  });
  if (options.disabled) {
    item.setAttribute("disabled", "true");
  }
  return item;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function getVisibleColumns(win: Window): ItemTreeColumn[] {
  const tree = getTree(win);
  let columns: ItemTreeColumn[] | undefined;
  try {
    columns = tree?._getVisibleColumns?.();
  } catch (e) {
    log("_getVisibleColumns failed", e);
  }
  if (!Array.isArray(columns)) return [];
  return columns
    .filter(
      (column) =>
        column && !column.hidden && typeof column.dataKey === "string",
    )
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

export function getTree(win: Window): VirtualizedTableLike | undefined {
  const itemTree = getTreeFromSource(win);
  if (itemTree) return itemTree;
  // Fall back to any other main window (e.g. when called from the
  // preferences window, where `win.ZoteroPane` does not exist).
  for (const other of Zotero.getMainWindows()) {
    const tree = getTreeFromSource(other);
    if (tree) return tree;
  }
  return undefined;
}

function getTreeFromSource(win: Window): VirtualizedTableLike | undefined {
  const pane = (
    win as unknown as { ZoteroPane?: { itemsView?: { tree?: unknown } } }
  ).ZoteroPane;
  const tree = pane?.itemsView?.tree;
  return tree && typeof tree === "object"
    ? (tree as VirtualizedTableLike)
    : undefined;
}

/**
 * `column.label` is either a translated string (custom columns, plugin
 * columns) or a Fluent/string key — try `Zotero.getString` for the latter and
 * fall back to whatever is there.
 */
export function columnLabel(column: ItemTreeColumn): string {
  const raw = column.label;
  if (typeof raw !== "string" || !raw.trim()) return column.dataKey;
  if (!/^[A-Za-z0-9_.-]+$/.test(raw) || !raw.includes(".")) return raw;
  try {
    const translated = Zotero.getString(raw);
    if (translated && translated !== raw) return translated;
  } catch {
    /* Not a known string key — use the raw value. */
  }
  return raw;
}

function log(...args: unknown[]): void {
  try {
    ztoolkit.log("[wrap-columns]", ...args);
  } catch {
    /* ztoolkit not ready — never break the plugin because of logging */
  }
}
