# ADR 0014: A vanilla TypeScript widget in a Shadow DOM, rendering text only

Date: 2026-11-06 · Status: accepted

## Context

The widget runs on someone else's page (the doctor's Next.js site), next to their CSS, scripts and
analytics. It must not break the page, must not be broken by it, must load fast on phones, and must
never turn model output into markup.

## Decision

- **No framework**: plain TypeScript and DOM APIs, built by esbuild into one IIFE of about 18 KiB.
  ARCHITECTURE.md planned Vite; esbuild alone is enough for one entry file and was already a
  dependency.
- **Shadow DOM** (open mode, so tests and assistive technology can reach it) with styles in a
  constructable stylesheet, falling back to a `<style>` element in older browsers.
- **Text only**: every API string goes through `textContent`. Icons are built with
  `createElementNS` from constant path data. The bundle contains no `innerHTML`.
- **Link allowlist in the widget too**: sources on the site over https; buttons to WhatsApp, Google
  Maps, `tel:` and `mailto:`. The API already filters; the widget does not trust that.
- **Memory-only state**: no `localStorage`, `sessionStorage` or cookies.
- **Texts from `GET /v1/config`**, with built-in defaults, so wording changes need no rebuild.
- **The site's palette** (ink, navy, teal, mist, paper, muted) and its Inter font through the CSS
  variable it already defines; teal only for focus rings because it fails contrast for text.

## Alternatives

- **React or Preact**: a nicer component model for a 300-line UI, but 4–40 KiB more and a second
  copy of React on a React site.
- **An iframe**: the strongest isolation, but a second document to host, harder focus and
  accessibility handling across frames, and resizing via postMessage.
- **Rendering markdown**: richer answers (lists, bold), but a sanitizer becomes part of the trust
  boundary. The prompt asks for plain text, which reads fine in a chat bubble.
- **Keeping the conversation in sessionStorage**: survives a reload, but leaves health-adjacent text
  in the browser after the visitor leaves the tab open on a shared computer.

## Consequences

- Reloading the page starts a new conversation.
- End-to-end tests run the built file in Chromium (Playwright) against the API app on PGlite with a
  scripted model: suggestions, sources, buttons, XSS, link filtering, errors, keyboard, deletion,
  emergencies, phone layout and an axe-core audit.
