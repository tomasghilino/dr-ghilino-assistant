# Learning notes: Phase 6, the widget

The widget is the only part a visitor ever sees. It is also the only part that runs on a page we do
not control. Both facts shape it.

## 1. Living on someone else's page

The doctor's site has its own CSS, scripts and (later) analytics. Two dangers:

- **The site breaks the widget**: a global `button { … }` rule restyles our buttons.
- **The widget breaks the site**: our `.message` class collides with theirs.

A **Shadow DOM** solves both: the widget's elements live in their own tree with their own styles.
Only inherited properties (fonts, colours) and CSS variables cross the boundary, which is why the
widget can pick up the site's Inter font through `--font-inter` without any coordination.

## 2. Never trust the text

The answer comes from a language model that read text from the internet (the site) and from a
visitor. If the widget did `bubble.innerHTML = answer`, a reply containing
`<img src=x onerror="…">` would run code on the doctor's site: XSS. So:

- every string goes through `textContent` (the browser treats it as characters, not markup);
- links are created by the widget itself, only for URLs that pass a strict allowlist;
- the e2e test sends `<img onerror>`, `<script>` and `<b>` through the real API and checks that no
  such element exists afterwards, and that no browser dialog opened.

This is the third layer of the same rule: the prompt asks for plain text, the API filters links,
and the widget renders text and allowlisted links only.

## 3. Accessibility is part of "working"

A visitor may use a screen reader or only a keyboard. What the widget does:

| Need                      | How                                                          |
| ------------------------- | ------------------------------------------------------------ |
| Know what the button does | `aria-label="Abrir el asistente virtual"`, `aria-expanded`   |
| Know a panel opened       | `role="dialog"` named by its title; focus moves to the input |
| Hear new messages         | `role="log"` with `aria-live="polite"`                       |
| Hear errors               | `role="alert"`                                               |
| Close without a mouse     | Escape, then focus returns to the launcher                   |
| Not get dizzy             | `prefers-reduced-motion` disables the animations             |

axe-core, the engine behind most accessibility checkers, runs inside the e2e test with the panel
open and a real answer on screen: zero serious or critical violations.

## 4. Testing the real thing

The e2e test does not test a mock of the widget. It:

1. builds `widget.js` exactly as it would be deployed;
2. serves a page from one origin and the API app from another (so CORS and the origin check are
   real);
3. runs the API on PGlite with the site fixtures and a scripted model (free and repeatable);
4. drives Chromium with Playwright: clicks, typing, keyboard, viewport changes.

Ten tests, about ten seconds. Screenshots against the real Claude are in `docs/img`.

## Self-check questions

1. Why is `textContent` safe where `innerHTML` is not?
2. The API already filters links. Why does the widget check them again?
3. What would break if the widget stored the conversation in `localStorage`?
4. Why does the e2e test serve the page and the API from different ports?
5. A visitor uses only the keyboard. Walk through asking a question and closing the panel.
