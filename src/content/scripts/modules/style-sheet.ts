import { config, version } from "../../../../package.json";

const STYLE_SHEET_PATH = `chrome://${config.addonRef}/content/zoteroPane.css`;
const DYNAMIC_STYLE_SHEET_ID = `${config.addonRef}-dynamic-stylesheet`;

function getHash(): string {
  if (__env__ === "production") return version;
  return String(Date.now());
}

export function registerStyleSheet(win: Window) {
  const doc = win.document;
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      id: `${config.addonRef}-stylesheet`,
      href: `${STYLE_SHEET_PATH}?v=${getHash()}`,
    },
  });
  doc.documentElement.appendChild(styles);
}

export function unregisterStyleSheet(win: Window) {
  const doc = win.document;
  const e = doc.getElementById(`${addon.data.config.addonRef}-stylesheet`);
  ztoolkit.log("unregisterStyleSheet", e);
  e?.remove();
}

/**
 * Create (or reuse) a `<style>` element holding rules that change at runtime,
 * e.g. the per-column wrapping rules. Rewriting `textContent` applies the new
 * rules immediately — no reload needed.
 */
export function updateDynamicStyleSheet(win: Window, css: string): void {
  const doc = win.document;
  let style = doc.getElementById(
    DYNAMIC_STYLE_SHEET_ID,
  ) as HTMLStyleElement | null;
  if (!style) {
    style = ztoolkit.UI.createElement(doc, "style", {
      properties: {
        id: DYNAMIC_STYLE_SHEET_ID,
        type: "text/css",
      },
    });
    doc.documentElement.appendChild(style);
  }
  style.textContent = css;
}

export function unregisterDynamicStyleSheet(win: Window): void {
  win.document.getElementById(DYNAMIC_STYLE_SHEET_ID)?.remove();
}
