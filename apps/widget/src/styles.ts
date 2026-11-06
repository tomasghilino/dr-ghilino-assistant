/**
 * Styles live inside the widget's Shadow DOM, so the site's CSS cannot break the widget and the
 * widget cannot leak styles into the site. Colors are the site's own (luis-ghilino globals.css):
 * ink, navy, teal, mist, paper, muted. Fonts inherit the site's Inter through its CSS variable
 * when present. Contrast: navy on white ≈ 10:1, muted on white ≈ 7.6:1 (WCAG AA for small text);
 * teal (≈ 3.4:1) is used only for focus rings and decoration, never for text.
 */
export const STYLES = `
:host {
  --ink: #010c11;
  --navy: #05445e;
  --teal: #189ab4;
  --teal-strong: #0f6a7d;
  --mist: #d4f1f4;
  --paper: #eff6f7;
  --muted: #3f5761;
  --danger: #8a1c1c;
  --radius: 18px;
  all: initial;
  font-family: var(--font-inter, ui-sans-serif), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
button, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.launcher {
  position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
  width: 60px; height: 60px; border-radius: 999px; border: 0; cursor: pointer;
  background: var(--navy); color: #fff;
  display: grid; place-items: center;
  box-shadow: 0 10px 30px -12px rgb(5 68 94 / 0.6);
  transition: background-color 150ms ease, transform 150ms ease;
}
.launcher:hover { background: var(--ink); }
.launcher svg { width: 28px; height: 28px; }
:host([data-position="left"]) .launcher { right: auto; left: 20px; }

.panel {
  position: fixed; bottom: 92px; right: 20px; z-index: 2147483000;
  width: min(390px, calc(100vw - 40px));
  height: min(620px, calc(100vh - 120px));
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid rgb(5 68 94 / 0.12); border-radius: var(--radius);
  box-shadow: 0 24px 60px -24px rgb(1 12 17 / 0.45);
  overflow: hidden;
  animation: rise 180ms ease-out;
}
:host([data-position="left"]) .panel { right: auto; left: 20px; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

header {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 12px 14px 18px; background: var(--navy); color: #fff;
}
header .titles { flex: 1; min-width: 0; }
header h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; }
header p { margin: 2px 0 0; font-size: 13px; opacity: 0.85; line-height: 1.3; }
.icon-button {
  width: 36px; height: 36px; border-radius: 999px; border: 0; cursor: pointer;
  background: transparent; color: #fff; display: grid; place-items: center;
}
.icon-button:hover { background: rgb(255 255 255 / 0.12); }
.icon-button svg { width: 18px; height: 18px; }

.log { flex: 1; overflow-y: auto; padding: 16px; background: var(--paper); display: flex; flex-direction: column; gap: 12px; }
.disclosure {
  margin: 0; padding: 10px 12px; border-radius: 12px; background: #fff;
  border: 1px solid rgb(5 68 94 / 0.12); color: var(--muted); font-size: 13px; line-height: 1.45;
}
.message { max-width: 88%; display: flex; flex-direction: column; gap: 8px; }
.message .bubble { padding: 10px 14px; border-radius: 16px; font-size: 15px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.assistant { align-self: flex-start; }
.message.assistant .bubble { background: #fff; border: 1px solid rgb(5 68 94 / 0.1); border-bottom-left-radius: 6px; }
.message.visitor { align-self: flex-end; }
.message.visitor .bubble { background: var(--navy); color: #fff; border-bottom-right-radius: 6px; }
.message.emergency .bubble { border: 2px solid var(--danger); }
.message.error .bubble { background: #fff; border: 1px solid var(--danger); color: var(--danger); }

.sources { margin: 0; padding: 0 4px; font-size: 13px; color: var(--muted); }
.sources span { font-weight: 600; }
.sources ul { margin: 4px 0 0; padding-left: 18px; }
.sources a { color: var(--navy); text-underline-offset: 2px; }

.actions, .suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
.chip, .action {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: 999px; font-size: 14px; line-height: 1.2; text-decoration: none; cursor: pointer;
  border: 1px solid rgb(5 68 94 / 0.25); background: #fff; color: var(--navy); font-weight: 500;
}
.chip:hover, .action:hover { border-color: var(--navy); background: var(--mist); }
.action.primary { background: var(--navy); color: #fff; border-color: var(--navy); }
.action.primary:hover { background: var(--ink); }
.action svg { width: 16px; height: 16px; }

.typing { align-self: flex-start; padding: 12px 16px; border-radius: 16px; background: #fff; border: 1px solid rgb(5 68 94 / 0.1); display: flex; gap: 4px; }
.typing i { width: 7px; height: 7px; border-radius: 999px; background: var(--muted); opacity: 0.4; animation: blink 1.2s infinite ease-in-out; }
.typing i:nth-child(2) { animation-delay: 0.2s; }
.typing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 0.9; } }

form { border-top: 1px solid rgb(5 68 94 / 0.12); padding: 10px 12px 8px; background: #fff; }
.composer { display: flex; align-items: flex-end; gap: 8px; }
textarea {
  flex: 1; resize: none; max-height: 120px; min-height: 44px;
  padding: 11px 14px; border-radius: 22px; border: 1px solid rgb(5 68 94 / 0.25);
  font-size: 16px; line-height: 1.35; background: #fff;
}
textarea:focus-visible { outline: 2px solid var(--teal); outline-offset: 0; border-color: var(--teal); }
.send {
  width: 44px; height: 44px; flex: none; border-radius: 999px; border: 0; cursor: pointer;
  background: var(--navy); color: #fff; display: grid; place-items: center;
}
.send:disabled { opacity: 0.45; cursor: not-allowed; }
.send svg { width: 20px; height: 20px; }
.meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 11.5px; color: var(--muted); line-height: 1.4; }
.counter { flex: none; }
.counter.over { color: var(--danger); font-weight: 600; }

@media (max-width: 480px) {
  .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; border: 0; bottom: 0; right: 0; }
  :host([data-position="left"]) .panel { left: 0; }
  .launcher { bottom: 16px; right: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .panel, .typing i { animation: none; }
  .launcher { transition: none; }
}
`;
