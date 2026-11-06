import { mount } from "./widget.ts";

// `document.currentScript` is only set while the script runs; capture it before any await.
const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => mount(script), { once: true });
} else {
  mount(script);
}
