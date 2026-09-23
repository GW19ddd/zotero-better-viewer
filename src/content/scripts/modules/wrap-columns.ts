/**
 * Per-column text wrapping for the item tree.
 *
 * Zotero clips every cell to a single line (`white-space: nowrap` +
 * `text-overflow: ellipsis`). This module lets the user pick — from the item
 * context menu — which columns should wrap instead; every other column keeps
 * the native one-line ellipsis behaviour.
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
 * - The selection is stored as a comma separated list of dataKeys in the
 *   `wrapColumns` pref; the CSS is regenerated on every change so it applies
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

interface ItemTreeColumn {
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

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function getWrapKeys(): string[] {
  const raw = getPref("wrapColumns");
  if (typeof raw !== "string") return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  );
}

function saveWrapKeys(keys: string[]): void {
  setPref("wrapColumns", Array.from(new Set(keys)).join(","));
}

function toggleKey(dataKey: string): void {
  const keys = new Set(getWrapKeys());
  if (keys.has(dataKey)) {
    keys.delete(dataKey);
  } else {
    keys.add(dataKey);
  }
  saveWrapKeys(Array.from(keys));
  for (const win of windows) {
    applyWrapCSS(win);
  }
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Wrapping rules for `dataKeys`. An empty list yields an empty stylesheet,
 * i.e. Zotero's default single-line ellipsis for every column.
 */
export function buildWrapCSS(dataKeys: string[]): string {
  const selectors: string[] = [];
  for (const dataKey of dataKeys) {
    const escaped = escapeCSSKey(dataKey);
    // Scoped to the item tree so other virtualized tables are untouched.
    selectors.push(`#zotero-items-tree .virtualized-table .cell.${escaped}`);
    selectors.push(
      `#zotero-items-tree .virtualized-table .cell.${escaped} .cell-text`,
    );
  }
  if (!selectors.length) return "";
  return `${selectors.join(",\n")} {\n  ${WRAP_DECLARATIONS.join(
    ";\n  ",
  )};\n}\n`;
}

function escapeCSSKey(dataKey: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(dataKey);
  }
  // `CSS` is not necessarily reachable from the bootstrap sandbox.
  return dataKey.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function applyWrapCSS(win: Window): void {
  updateDynamicStyleSheet(win, buildWrapCSS(getWrapKeys()));
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

function getVisibleColumns(win: Window): ItemTreeColumn[] {
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

function getTree(win: Window): VirtualizedTableLike | undefined {
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
function columnLabel(column: ItemTreeColumn): string {
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
