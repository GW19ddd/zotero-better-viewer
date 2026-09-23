/**
 * Column width sync for the Zotero item tree.
 *
 * Problem: out of the box Zotero only keeps the sum of the dragged column and
 * its *direct* right neighbour constant (see `_getResizeColumns()` in
 * `chrome/content/zotero/components/virtualized-table.js`). As soon as that
 * neighbour hits its minimum width the drag is blocked, even though the
 * remaining columns to the right still have plenty of room.
 *
 * Fix: wrap `tree._columns.onResize()` (the single place that writes column
 * widths) and, for every drag frame, rebuild the resize payload so that the
 * delta of the dragged column is absorbed *proportionally* by every other
 * resizable visible column — both to its left and to its right. Total width
 * stays constant, and dragging the right-most column works as well.
 *
 * Implementation notes (verified against Zotero 10.0.3 / omni.ja):
 * - `onResize` is an instance arrow property (not on the prototype), so it has
 *   to be replaced per instance and restored on unload.
 * - Widths handed to `onResize` are *rendered* (DOM) pixel widths, not
 *   `column.width` (which is stored without padding). Snapshots are therefore
 *   read from the header DOM with `getBoundingClientRect()`, exactly like
 *   Zotero itself does in `_handleResizerDragStop()`.
 * - `tree.state.resizing` (React state, set to the resizer index by
 *   `_handleResizerDragStart` and back to `null` by `_handleResizerDragStop`)
 *   is the reliable "a drag is in progress" flag and is preferred over any
 *   payload sniffing. The key count (`_handleResizerDragStart` sends every
 *   visible column, `_handleResizerDrag` only the two returned by
 *   `_getResizeColumns()`) is only used as a fallback when the React state
 *   cannot be read.
 * - `tree._columns` is recreated whenever the column set changes (switching
 *   library / view type, custom column changes), which would silently drop the
 *   patch. An accessor property is installed on the tree instance so every
 *   re-assignment is re-patched automatically.
 */

/** Mirrors `COLUMN_MIN_WIDTH` / `COLUMN_PADDING` of virtualized-table.js */
const COLUMN_MIN_WIDTH = 20;
const COLUMN_PADDING = 16;

const RETRY_INTERVAL_MS = 500;
const MAX_RETRIES = 10;

interface ItemTreeColumn {
  dataKey: string;
  width?: number;
  fixedWidth?: boolean;
  staticWidth?: boolean;
  minWidth?: number;
  hidden?: boolean;
  ordinal?: number;
  iconLabel?: boolean;
}

type OnResize = (widths: Record<string, number>, storePrefs?: boolean) => void;

interface ColumnsCollection {
  onResize?: OnResize;
}

interface VirtualizedTableLike {
  _columns?: ColumnsCollection;
  props?: { id?: string };
  _getVisibleColumns?: () => ItemTreeColumn[];
  rerender?: () => void;
  /**
   * React component state. `resizing` holds the index of the column resizer
   * being dragged (`null` when idle) — the preferred drag indicator.
   */
  state?: { resizing?: number | null; [key: string]: unknown };
  // Present in some versions; used opportunistically to flush column prefs.
  _writeColumnPrefsToFile?: (force?: boolean) => void;
}

interface WidthGiver {
  key: string;
  width: number;
  min: number;
}

interface WindowState {
  win: Window;
  tree: VirtualizedTableLike;
  columns?: ColumnsCollection;
  original?: OnResize;
  wrapper: OnResize;
  /** Rendered width (px) of every visible column when the drag started */
  snapshot: Map<string, number>;
  applying: boolean;
  /** `true` while `tree.state.resizing` reports an ongoing drag */
  dragging: boolean;
  retryTimer?: number;
  retries: number;
}

const states = new Map<Window, WindowState>();

function log(...args: unknown[]) {
  try {
    ztoolkit.log("[column-width-sync]", ...args);
  } catch {
    /* ztoolkit not ready — never break the plugin because of logging */
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerColumnWidthSync(win: Window): boolean {
  try {
    if (states.has(win)) {
      unregisterColumnWidthSync(win);
    }
    return tryRegister(win, 0);
  } catch (e) {
    log("register failed", e);
    return false;
  }
}

export function unregisterColumnWidthSync(win: Window): void {
  const state = states.get(win);
  if (!state) return;
  states.delete(win);

  if (state.retryTimer !== undefined) {
    win.clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }

  const tree = state.tree as unknown as Record<string, unknown>;
  const currentColumns = Object.hasOwn(tree, "_columns")
    ? tree._columns
    : undefined;

  restoreColumns(state);

  if (currentColumns !== undefined) {
    // Turn the accessor installed by `interceptColumnsProperty()` back into a
    // plain data property holding the current value.
    Object.defineProperty(tree, "_columns", {
      value: currentColumns,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function tryRegister(win: Window, retriesDone: number): boolean {
  const tree = getTree(win);
  if (!tree) {
    return scheduleRetry(win, retriesDone);
  }

  const state: WindowState = {
    win,
    tree,
    snapshot: new Map(),
    applying: false,
    dragging: false,
    retries: retriesDone,
    wrapper: () => {
      /* replaced right below */
    },
  };
  state.wrapper = (widths, storePrefs = false) => {
    handleOnResize(state, widths, storePrefs);
  };
  states.set(win, state);

  const patched = interceptColumnsProperty(state);
  if (!patched) {
    // Tree exists but its columns are not built yet — try again shortly.
    states.delete(win);
    return scheduleRetry(win, retriesDone);
  }
  return true;
}

function scheduleRetry(win: Window, retriesDone: number): boolean {
  if (retriesDone >= MAX_RETRIES) {
    log("item tree not available, giving up");
    return false;
  }
  const timer = win.setTimeout(() => {
    const state = states.get(win);
    if (state) state.retryTimer = undefined;
    tryRegister(win, retriesDone + 1);
  }, RETRY_INTERVAL_MS);
  // Keep a handle even if the state was not created yet, so unregister can
  // cancel a pending retry.
  const state = states.get(win);
  if (state) {
    state.retryTimer = timer;
  } else {
    states.set(win, {
      win,
      tree: {} as VirtualizedTableLike,
      snapshot: new Map(),
      applying: false,
      dragging: false,
      retries: retriesDone + 1,
      retryTimer: timer,
      wrapper: () => {
        /* retrying */
      },
    });
  }
  return false;
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
 * Replace `tree._columns` with an accessor so that every re-assignment
 * (`new Columns(this)` on view/column changes) gets patched again.
 */
function interceptColumnsProperty(state: WindowState): boolean {
  const tree = state.tree as unknown as Record<string, unknown>;
  const existing = Object.getOwnPropertyDescriptor(tree, "_columns");
  if (existing && (existing.get || existing.set)) {
    // Someone else already owns this property — patch what is there and stop.
    return patchColumns(state, tree._columns as ColumnsCollection | undefined);
  }

  let value = tree._columns as ColumnsCollection | undefined;
  Object.defineProperty(tree, "_columns", {
    configurable: true,
    enumerable: existing ? existing.enumerable : true,
    get: () => value,
    set: (next: ColumnsCollection | undefined) => {
      value = next;
      patchColumns(state, next);
    },
  });
  return patchColumns(state, value);
}

function patchColumns(
  state: WindowState,
  columns: ColumnsCollection | undefined,
): boolean {
  if (!columns || typeof columns.onResize !== "function") return false;
  if (columns.onResize === state.wrapper) return true;
  state.original = columns.onResize;
  state.columns = columns;
  columns.onResize = state.wrapper;
  return true;
}

function restoreColumns(state: WindowState) {
  const columns = state.columns;
  if (!columns || !state.original) return;
  if (columns.onResize === state.wrapper) {
    columns.onResize = state.original;
  }
  state.original = undefined;
  state.columns = undefined;
}

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

function handleOnResize(
  state: WindowState,
  widths: Record<string, number>,
  storePrefs: boolean,
) {
  const tree = state.tree;
  const keys = widths ? Object.keys(widths) : [];
  const visible = getVisibleColumns(tree);

  // Re-entrancy guard: our own call to the original implementation.
  if (state.applying || !widths || !keys.length || !visible.length) {
    callOriginal(state, widths, storePrefs);
    return;
  }

  // Is the user currently dragging a resizer? `tree.state.resizing` is the
  // authoritative answer; the key count is only a fallback for builds where
  // the React state cannot be read.
  const resizing = isResizing(tree);
  const fullPayload = keys.length >= visible.length;
  const dragFrame =
    resizing === undefined ? !fullPayload : resizing && !fullPayload;

  if (!dragFrame) {
    // Either the pre-drag baseline (`_handleResizerDragStart` sends every
    // visible column) or a programmatic full refresh (reorder / hide /
    // restore). Refresh the baseline and let the payload through untouched.
    if (resizing === false) {
      state.dragging = false;
    }
    state.snapshot = readWidthsFromDOM(state.win, tree);
    callOriginal(state, widths, storePrefs);
    return;
  }

  // Drag frame: only the dragged column and one neighbour are present.
  if ((resizing === true && !state.dragging) || !state.snapshot.size) {
    // First frame of a new drag (or a drag whose start we never saw) — take
    // the baseline now so the delta below is measured against it.
    state.dragging = true;
    state.snapshot = readWidthsFromDOM(state.win, tree);
  }

  let redistributed: Record<string, number> | undefined;
  try {
    redistributed = redistribute(state.snapshot, widths, visible);
  } catch (e) {
    log("redistribute failed", e);
    redistributed = undefined;
  }
  if (!redistributed) {
    // No column can give way (e.g. only two columns and the other one is
    // fixed width) — degrade to Zotero's own two-column behaviour.
    callOriginal(state, widths, storePrefs);
    return;
  }

  callOriginal(state, redistributed, storePrefs);

  // onResize only writes CSSOM flex-basis; the rows need a repaint.
  try {
    tree.rerender?.();
  } catch (e) {
    log("rerender failed", e);
  }

  if (storePrefs) {
    // storePrefs=true is the only persistence point; flush it if possible.
    try {
      if (typeof tree._writeColumnPrefsToFile === "function") {
        tree._writeColumnPrefsToFile(true);
      }
    } catch (e) {
      log("flush prefs failed", e);
    }
  }
}

/**
 * `true` while a column resizer is being dragged, `false` while it is not and
 * `undefined` when the React state is unavailable (fall back to the key count
 * heuristic in that case).
 */
function isResizing(tree: VirtualizedTableLike): boolean | undefined {
  const state = tree.state;
  if (!state || typeof state !== "object" || !("resizing" in state)) {
    return undefined;
  }
  const value = state.resizing;
  return value !== null && value !== undefined;
}

function callOriginal(
  state: WindowState,
  widths: Record<string, number>,
  storePrefs: boolean,
) {
  const original = state.original;
  if (!original) return;
  state.applying = true;
  try {
    original(widths, storePrefs);
  } catch (e) {
    log("original onResize failed", e);
  } finally {
    state.applying = false;
  }
}

function getVisibleColumns(tree: VirtualizedTableLike): ItemTreeColumn[] {
  let columns: ItemTreeColumn[] | undefined;
  try {
    columns = tree._getVisibleColumns?.();
  } catch (e) {
    log("getVisibleColumns failed", e);
  }
  if (!Array.isArray(columns) || !columns.length) {
    try {
      columns = (
        tree._columns as unknown as { getAsArray?: () => ItemTreeColumn[] }
      )?.getAsArray?.();
    } catch (e) {
      log("getAsArray failed", e);
    }
  }
  if (!Array.isArray(columns)) return [];
  // Left-to-right order drives which columns "give way", so sort by ordinal
  // (stable sort keeps the original order for equal ordinals).
  return columns
    .filter((c) => c && !c.hidden && typeof c.dataKey === "string")
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

/**
 * Rendered width of every visible column, read from the header DOM (the same
 * way Zotero measures columns during a drag).
 */
function readWidthsFromDOM(
  win: Window,
  tree: VirtualizedTableLike,
): Map<string, number> {
  const result = new Map<string, number>();
  const visible = getVisibleColumns(tree);
  if (!visible.length) return result;

  const id = tree.props?.id || "item-tree-main";
  let cells: ArrayLike<Element> | undefined;
  try {
    cells = win.document.querySelectorAll(
      `#${escapeId(win, id)} .virtualized-table-header .cell`,
    );
  } catch {
    cells = undefined;
  }

  if (cells && cells.length) {
    const known = new Set(visible.map((c) => c.dataKey));
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      let key: string | undefined;
      for (let j = 0; j < cell.classList.length; j++) {
        const cls = cell.classList.item(j);
        if (cls && known.has(cls)) {
          key = cls;
          break;
        }
      }
      // Fall back to positional mapping (header cells follow column order).
      if (!key && i < visible.length) {
        key = visible[i].dataKey;
      }
      if (!key) continue;
      result.set(key, cell.getBoundingClientRect().width);
    }
  }

  if (!result.size) {
    // DOM unavailable: approximate from stored widths (padding is not
    // included in `column.width`, so this is slightly off).
    for (const column of visible) {
      result.set(
        column.dataKey,
        (column.width ?? 0) + (column.iconLabel ? 0 : COLUMN_PADDING),
      );
    }
  }
  return result;
}

/**
 * Zotero hands over `{ draggedColumn, rightNeighbour }`; the left-most of the
 * two is the one the user is actually resizing (`_getResizeColumns()` may pick
 * a different column when the grabbed one is fixed-width).
 */
function pickDraggedKey(
  widths: Record<string, number>,
  visible: ItemTreeColumn[],
): string | undefined {
  const keys = Object.keys(widths).filter((key) =>
    visible.some((c) => c.dataKey === key),
  );
  if (!keys.length) return undefined;
  const ordinalOf = (key: string) => {
    const index = visible.findIndex((c) => c.dataKey === key);
    return visible[index]?.ordinal ?? index;
  };
  return keys.reduce((a, b) => (ordinalOf(b) < ordinalOf(a) ? b : a));
}

function columnMinWidth(column: ItemTreeColumn): number {
  const padding = column.iconLabel ? 0 : COLUMN_PADDING;
  return (column.minWidth ?? COLUMN_MIN_WIDTH) + padding;
}

/**
 * Spread `target - snapshot[dragged]` over *every* other resizable visible
 * column — the ones to the right **and** the ones to the left of the dragged
 * column — proportionally to their baseline width, clamping each one at its
 * minimum. Leftover that no column can absorb shrinks the target instead, so
 * the total width is always preserved.
 */
function redistribute(
  snapshot: Map<string, number>,
  widths: Record<string, number>,
  visible: ItemTreeColumn[],
): Record<string, number> | undefined {
  const dragged = pickDraggedKey(widths, visible);
  if (!dragged) return undefined;

  const base = snapshot.get(dragged);
  if (base === undefined) return undefined;

  const requested = widths[dragged];
  let target = typeof requested === "number" ? requested : base;

  const draggedIndex = visible.findIndex((c) => c.dataKey === dragged);
  if (draggedIndex < 0) return undefined;
  const draggedColumn = visible[draggedIndex] as ItemTreeColumn;
  const draggedMin = columnMinWidth(draggedColumn);

  // Never let the dragged column shrink below its own minimum — the surplus
  // simply stays unallocated rather than producing a negative width.
  const minTarget = Math.min(base, draggedMin);
  if (!(target > minTarget)) target = minTarget;

  const delta = target - base;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return undefined;

  // Only columns strictly to the RIGHT of the dragged one give way. Every
  // column on the left (including the immediate left neighbour) keeps its
  // width untouched — this holds for dragging right *and* dragging left.
  const givers: WidthGiver[] = [];
  for (let i = draggedIndex + 1; i < visible.length; i++) {
    const column = visible[i];
    if (!column) continue;
    if (column.hidden || column.fixedWidth || column.staticWidth) continue;
    const baseline = snapshot.get(column.dataKey);
    givers.push({
      key: column.dataKey,
      width:
        baseline !== undefined
          ? baseline
          : (column.width ?? 0) + (column.iconLabel ? 0 : COLUMN_PADDING),
      min: columnMinWidth(column),
    });
  }
  // Nothing can give way: let Zotero handle the frame on its own.
  if (!givers.length) return undefined;

  const next = new Map<string, number>(givers.map((g) => [g.key, g.width]));
  let remaining = delta;
  let pool = givers.slice();

  // Each pass hands `remaining` out proportionally; columns that bottom out
  // leave the pool and their surplus is handed to the next pass.
  for (let guard = 0; guard < 32 && pool.length; guard++) {
    if (Math.abs(remaining) < 0.5) break;
    const total = pool.reduce((sum, g) => sum + (next.get(g.key) ?? 0), 0);
    if (total <= 0) break;

    const survivors: WidthGiver[] = [];
    let absorbed = 0;
    let clamped = false;
    for (const giver of pool) {
      const current = next.get(giver.key) ?? 0;
      const share = remaining * (current / total);
      const candidate = current - share;
      if (candidate < giver.min) {
        absorbed += current - giver.min;
        next.set(giver.key, giver.min);
        clamped = true;
      } else {
        absorbed += share;
        next.set(giver.key, candidate);
        survivors.push(giver);
      }
    }
    remaining -= absorbed;
    if (!clamped) break;
    pool = survivors;
  }

  // Everything to the right is at its minimum — cap the dragged column.
  if (remaining > 0) {
    target -= remaining;
  }

  const result: Record<string, number> = { [dragged]: round(target) };
  for (const [key, width] of next) {
    result[key] = round(width);
  }
  return result;
}

function escapeId(win: Window, id: string): string {
  const css = (
    win as unknown as {
      CSS?: { escape?: (value: string) => string };
    }
  ).CSS;
  return typeof css?.escape === "function" ? css.escape(id) : id;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
