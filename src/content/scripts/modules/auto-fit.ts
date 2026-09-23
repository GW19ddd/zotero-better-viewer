/**
 * "Auto fit" for the Zotero item tree — make the content fit instead of being
 * clipped with an ellipsis.
 *
 * Two independent tools, both available from an "Auto Fit" sub menu of the
 * item context menu (`#zotero-itemmenu`) and optionally run automatically when
 * a main window finishes loading:
 *
 * - **Fit column widths** — measures the widest rendered text of a column and
 *   grows the column to exactly that width.
 * - **Shrink fonts** — for columns whose content does not fit, lowers the font
 *   size just enough for the text to fit at the current column width. Already
 *   wrapped columns are skipped (their content is visible already) and the
 *   result can be reset.
 *
 * Implementation notes (verified against Zotero 10.0.3 / omni.ja):
 * - Every rendered cell carries its `dataKey` as a class
 *   (`.cell.title`), so a plain CSS class selector can address a column.
 *   Custom column dataKeys may contain `@`/`.`, hence `CSS.escape`.
 * - Text width is measured with Canvas 2D `measureText()` using the cell's own
 *   computed `font`, which is far cheaper than cloning nodes and does not
 *   disturb the virtualized table.
 * - Widths are written through `tree._columns.onResize()`, the single place
 *   that writes column widths. The payload intentionally contains **every**
 *   visible column, because a partial payload would be mistaken for a drag
 *   frame by `column-width-sync` (and would also be less robust in general).
 *
 * Known limitations (approximations that are inherent to a virtualized table):
 * - Only the rows currently rendered in the DOM are measured. The result is
 *   therefore "the widest content among the rows on screen", not the widest
 *   content of the whole library.
 * - Fitting column widths only ever **grows** a column: shrinking based on a
 *   partial sample would truncate rows that are not rendered.
 * - Font sizes are measured with the addon's own font-size rules temporarily
 *   removed, so repeated runs are idempotent (they do not shrink further).
 */

import { config } from "../../../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { getTree, getVisibleColumns, getWrapKeys } from "./wrap-columns";

/** Mirrors `COLUMN_PADDING` / `COLUMN_MIN_WIDTH` of virtualized-table.js. */
const COLUMN_PADDING = 16;
const COLUMN_MIN_WIDTH = 20;
/** Slack added to a fitted width so the text is not flush against the edge. */
const FIT_SLACK = 4;
/** Approximate width of the leading type icon of a cell. */
const ICON_WIDTH = 20;
/** Never shrink a font below this size — smaller text is unreadable. */
const MIN_FONT_SIZE = 9;
/** Hard ceiling for a single fitted column. */
const MAX_FIT_WIDTH = 800;
/** ...and no single column may take more than this share of the container. */
const MAX_FIT_WIDTH_RATIO = 0.6;

const RETRY_INTERVAL_MS = 500;
const MAX_RETRIES = 10;

const HTML_NS = "http://www.w3.org/1999/xhtml";

const MENU_ID = `${config.addonRef}-itemmenu-auto-fit`;
const MENU_POPUP_ID = `${config.addonRef}-itemmenu-auto-fit-popup`;
const STYLE_SHEET_ID = `${config.addonRef}-autofit-stylesheet`;

const PREFS_PREFIX = config.prefsPrefix;

// ---------------------------------------------------------------------------
// Types (private Zotero APIs)
// ---------------------------------------------------------------------------

interface FitColumn {
  dataKey: string;
  width?: number;
  fixedWidth?: boolean;
  staticWidth?: boolean;
  minWidth?: number;
  hidden?: boolean;
  ordinal?: number;
  iconLabel?: boolean;
}

interface FitTree {
  props?: { id?: string };
  _columns?: {
    onResize?: (widths: Record<string, number>, store?: boolean) => void;
  };
  rerender?: () => void;
}

/** Result of measuring one column. */
interface ColumnMeasure {
  /** Width needed to display the widest sampled text (padding excluded). */
  text: number;
  /** Width taken by a leading icon in the widest sampled cell. */
  icon: number;
  /** Font size (px) of the sampled cell, i.e. the base size to scale from. */
  fontSize: number;
}

interface WindowState {
  win: Window;
  /** Canvas 2D context used for text measurement (one per window). */
  ctx?: CanvasRenderingContext2D;
  /** Pending "run automatically once the tree is ready" timers. */
  timers: Set<number>;
}

const states = new Map<Window, WindowState>();

/** Per-column font size overrides, `dataKey -> px`. */
type FontSizeMap = Record<string, number>;

/** Handles returned by `Zotero.Prefs.registerObserver`. */
let prefObservers: symbol[] = [];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAutoFit(win: Window): boolean {
  try {
    if (states.has(win)) {
      unregisterAutoFit(win);
    }
    states.set(win, { win, timers: new Set() });

    applyFontCSS(win);
    registerMenu(win);
    return true;
  } catch (e) {
    log("register failed", e);
    return false;
  }
}

export function unregisterAutoFit(win: Window): void {
  const state = states.get(win);
  if (state) {
    states.delete(win);
    for (const timer of state.timers) {
      win.clearTimeout(timer);
    }
    state.timers.clear();
  }
  win.document.getElementById(MENU_ID)?.remove();
  win.document.getElementById(STYLE_SHEET_ID)?.remove();
}

/**
 * Run the configured auto-fit actions once the item tree of `win` is ready.
 * Called from `onMainWindowLoad`; the tree is usually not built yet at that
 * point, so each action retries a few times (same pattern as
 * `column-width-sync`).
 */
export function runAutoFitOnLoad(win: Window): void {
  if (!states.has(win)) {
    registerAutoFit(win);
  }
  scheduleAuto(win, "width", 0);
  scheduleAuto(win, "font", 0);
}

type AutoKind = "width" | "font";

function scheduleAuto(win: Window, kind: AutoKind, attempt: number): void {
  const enabled = getPref(
    kind === "width" ? "autoFitWidthOnLoad" : "autoFitFontOnLoad",
  );
  if (!enabled) return;

  const done = kind === "width" ? fitColumnWidths(win) : fitFontSizes(win);
  if (done) return;
  if (attempt >= MAX_RETRIES) {
    log("auto", kind, "gave up — item tree unavailable");
    return;
  }
  const timer = win.setTimeout(() => {
    states.get(win)?.timers.delete(timer);
    scheduleAuto(win, kind, attempt + 1);
  }, RETRY_INTERVAL_MS);
  const state = states.get(win);
  if (state) {
    state.timers.add(timer);
  } else {
    win.clearTimeout(timer);
  }
}

/** Keep every window's font-size CSS in sync with the pref. */
export function registerAutoFitPrefObservers(): void {
  if (prefObservers.length) return;
  try {
    prefObservers.push(
      Zotero.Prefs.registerObserver(
        `${PREFS_PREFIX}.fontSizes`,
        () => applyFontCSSToAllWindows(),
        true,
      ),
    );
  } catch (e) {
    log("failed to observe pref", e);
  }
}

export function unregisterAutoFitPrefObservers(): void {
  for (const handle of prefObservers) {
    try {
      Zotero.Prefs.unregisterObserver(handle);
    } catch (e) {
      log("failed to unregister pref observer", e);
    }
  }
  prefObservers = [];
}

export function applyFontCSSToAllWindows(): void {
  for (const state of states.values()) {
    applyFontCSS(state.win);
  }
}

// ---------------------------------------------------------------------------
// C1 — fit column widths
// ---------------------------------------------------------------------------

/**
 * Grow every visible, resizable column so that the widest text sampled from
 * the rendered rows fits without an ellipsis.
 *
 * Returns `false` when the tree is not ready yet (so the caller can retry).
 */
export function fitColumnWidths(win: Window): boolean {
  try {
    const tree = getTree(win) as unknown as FitTree | undefined;
    if (!tree || typeof tree._columns?.onResize !== "function") return false;

    const columns = getVisibleColumns(win) as unknown as FitColumn[];
    if (!columns.length) return false;

    const current = readRenderedWidths(win, tree, columns);
    if (!current.size) return false;

    const ceiling = maxFitWidth(win, tree);
    const payload: Record<string, number> = {};
    let changed = false;

    for (const column of columns) {
      const key = column.dataKey;
      const width = current.get(key);
      if (width === undefined) continue;
      // Fixed / icon-only columns cannot be resized.
      if (column.fixedWidth || column.staticWidth || column.iconLabel) {
        payload[key] = width;
        continue;
      }
      const measured = measureColumn(win, tree, key);
      // Grow-only: a partial sample must never be used to shrink a column.
      const wanted = measured
        ? clamp(
            measured.text + measured.icon + COLUMN_PADDING + FIT_SLACK,
            columnMinWidth(column),
            ceiling,
          )
        : width;
      const next = wanted > width ? wanted : width;
      if (next !== width) changed = true;
      payload[key] = next;
    }

    // Every visible column has to be part of the payload: a partial one would
    // look like a drag frame to `column-width-sync` and be redistributed.
    for (const column of columns) {
      const key = column.dataKey;
      if (key in payload) continue;
      payload[key] =
        current.get(key) ??
        (column.width ?? 0) + (column.iconLabel ? 0 : COLUMN_PADDING);
    }
    if (!changed) return true;

    (
      tree._columns as {
        onResize: NonNullable<FitTree["_columns"]>["onResize"];
      }
    ).onResize?.(payload, true);
    tree.rerender?.();
    return true;
  } catch (e) {
    log("fitColumnWidths failed", e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// C2 — shrink fonts
// ---------------------------------------------------------------------------

/**
 * Lower the font size of every visible, non-wrapped, resizable column whose
 * content does not fit, just enough for it to fit at the current width.
 * Columns that already fit (or that are wrapped) lose their override, so the
 * operation is idempotent.
 *
 * Returns `false` when the tree is not ready yet (so the caller can retry).
 */
export function fitFontSizes(win: Window): boolean {
  try {
    const tree = getTree(win) as unknown as FitTree | undefined;
    if (!tree) return false;

    const columns = getVisibleColumns(win) as unknown as FitColumn[];
    if (!columns.length) return false;

    const wrapped = new Set(getWrapKeys());
    const current = readRenderedWidths(win, tree, columns);
    if (!current.size) return false;

    // Measure with our own font-size rules removed, otherwise every run would
    // shrink on top of the previous one.
    const style = win.document.getElementById(STYLE_SHEET_ID);
    const previousCSS = style?.textContent ?? "";
    if (style) style.textContent = "";

    const next: FontSizeMap = {};
    try {
      for (const column of columns) {
        const key = column.dataKey;
        // A wrapped column already shows everything — never shrink its font.
        if (wrapped.has(key)) continue;
        if (column.fixedWidth || column.staticWidth || column.iconLabel)
          continue;
        const width = current.get(key);
        if (width === undefined) continue;

        const measured = measureColumn(win, tree, key);
        if (!measured || !measured.fontSize) continue;
        const needed = measured.text + measured.icon + COLUMN_PADDING;
        if (needed <= width) continue;

        const scaled = measured.fontSize * (width / needed);
        const size = clamp(scaled, MIN_FONT_SIZE, measured.fontSize);
        if (size < measured.fontSize - 0.05) {
          next[key] = Math.round(size * 10) / 10;
        }
      }
    } finally {
      if (style) style.textContent = previousCSS;
    }

    saveFontSizes(next);
    applyFontCSS(win);
    tree.rerender?.();
    return true;
  } catch (e) {
    log("fitFontSizes failed", e);
    return false;
  }
}

/** Drop every font-size override and restore Zotero's default sizes. */
export function resetFontSizes(win?: Window): void {
  saveFontSizes({});
  if (win) {
    applyFontCSS(win);
  } else {
    applyFontCSSToAllWindows();
  }
}

// ---------------------------------------------------------------------------
// Font size preference
// ---------------------------------------------------------------------------

function getFontSizes(): FontSizeMap {
  const raw = getPref("fontSizes");
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: FontSizeMap = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch (e) {
    log("could not parse fontSizes pref", e);
    return {};
  }
}

function saveFontSizes(sizes: FontSizeMap): void {
  const text = Object.keys(sizes).length ? JSON.stringify(sizes) : "";
  setPref("fontSizes", text);
}

// ---------------------------------------------------------------------------
// Font size CSS
// ---------------------------------------------------------------------------

export function buildFontCSS(sizes: FontSizeMap): string {
  const rules: string[] = [];
  for (const [dataKey, size] of Object.entries(sizes)) {
    const escaped = escapeCSSKey(dataKey);
    // Scoped to the rows so the header keeps its own font size.
    rules.push(
      `#zotero-items-tree .virtualized-table .row .cell.${escaped},\n` +
        `#zotero-items-tree .virtualized-table .row .cell.${escaped} .cell-text {\n` +
        `  font-size: ${size}px !important;\n}\n`,
    );
  }
  return rules.join("");
}

function applyFontCSS(win: Window): void {
  const css = buildFontCSS(getFontSizes());
  let style = win.document.getElementById(STYLE_SHEET_ID);
  if (!css) {
    // Nothing to shrink — drop the element so the defaults apply untouched.
    style?.remove();
    return;
  }
  if (!style) {
    style = ztoolkit.UI.createElement(win.document, "style", {
      properties: {
        id: STYLE_SHEET_ID,
        type: "text/css",
      },
    });
    win.document.documentElement.appendChild(style);
  }
  style.textContent = css;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Widest sampled content of one column.
 *
 * Only the rows currently present in the DOM are sampled — a virtualized
 * table renders just the viewport, so this is "the widest visible row", which
 * is a good enough approximation for interactive fitting.
 */
function measureColumn(
  win: Window,
  tree: FitTree,
  dataKey: string,
): ColumnMeasure | undefined {
  const ctx = getContext(win);
  if (!ctx) return undefined;

  let cells: ArrayLike<Element>;
  try {
    cells = win.document.querySelectorAll(
      `#${escapeCSSKey(treeId(tree))} .virtualized-table-body .row .cell.${escapeCSSKey(dataKey)}`,
    );
  } catch (e) {
    log("cell query failed", dataKey, e);
    return undefined;
  }
  if (!cells.length) return undefined;

  let text = 0;
  let icon = 0;
  let fontSize = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as Element;
    const content = cellText(cell);
    if (!content) continue;
    const style = win.getComputedStyle(cell);
    if (!style) continue;
    ctx.font =
      style.font && style.font.trim()
        ? style.font
        : `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    text = Math.max(text, ctx.measureText(content).width);
    if (cell.querySelector(".cell-icon, .icon")) {
      icon = Math.max(icon, ICON_WIDTH);
    }
    if (!fontSize) {
      const size = Number.parseFloat(style.fontSize);
      if (Number.isFinite(size)) fontSize = size;
    }
  }
  if (!text && !icon) return undefined;
  return { text, icon, fontSize };
}

function cellText(cell: Element): string {
  const inner = cell.querySelector(".cell-text");
  if (inner && inner.textContent) return inner.textContent;
  // Zotero's own tooltip code uses the cell itself when its first child is a
  // text node; fall back to the direct text nodes before using everything.
  let direct = "";
  for (let i = 0; i < cell.childNodes.length; i++) {
    const node = cell.childNodes[i] as ChildNode;
    if (node.nodeType === 3) direct += node.nodeValue ?? "";
  }
  if (direct.trim()) return direct;
  return cell.textContent ?? "";
}

function getContext(win: Window): CanvasRenderingContext2D | undefined {
  const state = states.get(win);
  if (state?.ctx) return state.ctx;
  try {
    const canvas = win.document.createElementNS(
      HTML_NS,
      "canvas",
    ) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return undefined;
    if (state) state.ctx = ctx;
    return ctx;
  } catch (e) {
    log("canvas unavailable", e);
    return undefined;
  }
}

/** Rendered (DOM) width of every visible column, read from the header. */
function readRenderedWidths(
  win: Window,
  tree: FitTree,
  columns: FitColumn[],
): Map<string, number> {
  const result = new Map<string, number>();
  const id = treeId(tree);
  let cells: ArrayLike<Element> | undefined;
  try {
    cells = win.document.querySelectorAll(
      `#${escapeCSSKey(id)} .virtualized-table-header .cell`,
    );
  } catch {
    cells = undefined;
  }
  const known = new Set(columns.map((c) => c.dataKey));
  if (cells && cells.length) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as Element;
      let key: string | undefined;
      for (let j = 0; j < cell.classList.length; j++) {
        const cls = cell.classList.item(j);
        if (cls && known.has(cls)) {
          key = cls;
          break;
        }
      }
      if (!key && i < columns.length) key = columns[i].dataKey;
      if (!key) continue;
      result.set(key, cell.getBoundingClientRect().width);
    }
  }
  if (!result.size) {
    for (const column of columns) {
      result.set(
        column.dataKey,
        (column.width ?? 0) + (column.iconLabel ? 0 : COLUMN_PADDING),
      );
    }
  }
  return result;
}

function maxFitWidth(win: Window, tree: FitTree): number {
  let container = 0;
  try {
    container =
      win.document.getElementById(treeId(tree))?.getBoundingClientRect()
        .width ?? 0;
  } catch {
    container = 0;
  }
  if (!container) container = 1200;
  return Math.max(
    COLUMN_PADDING * 2,
    Math.min(container * MAX_FIT_WIDTH_RATIO, MAX_FIT_WIDTH),
  );
}

function columnMinWidth(column: FitColumn): number {
  const padding = column.iconLabel ? 0 : COLUMN_PADDING;
  return (column.minWidth ?? COLUMN_MIN_WIDTH) + padding;
}

function treeId(tree: FitTree): string {
  const id = tree.props?.id;
  return typeof id === "string" && id ? id : "item-tree-main";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Custom column dataKeys contain characters like `@` or `.`, so they have to
 * be escaped before they can be used inside a CSS selector.
 */
function escapeCSSKey(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, (char) => `\\${char}`);
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
    label: getString("itemmenu-auto-fit-label"),
    popupId: MENU_POPUP_ID,
    children: [
      {
        tag: "menuitem",
        id: `${MENU_ID}-width`,
        label: getString("itemmenu-auto-fit-width-label"),
        commandListener: () => {
          try {
            fitColumnWidths(win);
          } catch (e) {
            log("fit widths from menu failed", e);
          }
        },
      },
      {
        tag: "menuitem",
        id: `${MENU_ID}-font`,
        label: getString("itemmenu-auto-fit-font-label"),
        commandListener: () => {
          try {
            fitFontSizes(win);
          } catch (e) {
            log("fit fonts from menu failed", e);
          }
        },
      },
      {
        tag: "menuitem",
        id: `${MENU_ID}-font-reset`,
        label: getString("itemmenu-auto-fit-font-reset-label"),
        commandListener: () => {
          try {
            resetFontSizes(win);
          } catch (e) {
            log("reset fonts from menu failed", e);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  try {
    ztoolkit.log("[auto-fit]", ...args);
  } catch {
    /* ztoolkit not ready — never break the plugin because of logging */
  }
}
