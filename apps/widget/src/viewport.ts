/**
 * On a phone the chat panel must cover what the visitor actually sees. iOS Safari keeps fixed
 * elements on the layout viewport: when the keyboard opens it pans the visible area instead, so a
 * full-height panel slid up (header off screen, the page showing below) and the input ended up
 * under the keyboard. The visual viewport is the visible area: the panel takes its size and
 * position, and the page behind does not scroll while the chat covers it.
 *
 * Returns the function that undoes it all (listeners, inline styles, the page's overflow).
 */
export function coverVisualViewport(panel: HTMLElement, onChange: () => void): () => void {
  const page = document.documentElement;
  const previousOverflow = page.style.overflow;
  page.style.overflow = "hidden";
  const viewport = window.visualViewport;
  const place = () => {
    if (!viewport) return;
    const style = panel.style;
    style.top = `${viewport.offsetTop}px`;
    style.left = `${viewport.offsetLeft}px`;
    style.width = `${viewport.width}px`;
    style.height = `${viewport.height}px`;
    style.bottom = "auto";
    style.right = "auto";
    onChange();
  };
  place();
  viewport?.addEventListener("resize", place);
  viewport?.addEventListener("scroll", place);
  return () => {
    viewport?.removeEventListener("resize", place);
    viewport?.removeEventListener("scroll", place);
    for (const property of ["top", "left", "width", "height", "bottom", "right"]) {
      panel.style.removeProperty(property);
    }
    page.style.overflow = previousOverflow;
  };
}
