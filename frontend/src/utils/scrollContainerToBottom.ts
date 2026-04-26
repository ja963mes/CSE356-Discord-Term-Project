/**
 * Programmatic scroll-to-bottom on a scrollable column, after layout.
 * Prefer this over scrollIntoView({ behavior: "smooth" }) on a sentinel — avoids fighting
 * CSS `scroll-smooth` on the same container and reduces visible jitter when content height changes.
 */
export function scrollContainerToBottom(container: HTMLElement | null | undefined): void {
  if (!container) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  });
}
