/** Tiny DOM builder helpers used across the webview. */

type AttrValue = string | boolean | number | undefined;

export type DomChild =
  | Node
  | string
  | { html: string }
  | null
  | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue> | null,
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "data") Object.assign(node.dataset, value);
      else node.setAttribute(key, String(value));
    }
  }
  append(node, ...children);
  return node;
}

export function append(
  parent: Node,
  ...children: DomChild[]
): void {
  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === "string") {
      parent.appendChild(document.createTextNode(child));
    } else if (child && typeof child === "object" && "html" in child && typeof (child as { html: string }).html === "string") {
      const template = document.createElement("template");
      template.innerHTML = (child as { html: string }).html;
      parent.appendChild(template.content.cloneNode(true));
    } else if (child instanceof Node) {
      parent.appendChild(child);
    }
  }
}

/** Creates an element containing inline SVG markup cleanly without raw text escaping. */
export function icon(svg: string, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `icon ${className}` : "icon";
  span.innerHTML = svg;
  return span;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function on(
  target: EventTarget,
  event: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions
): () => void {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler);
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mins)}:${pad(secs)}`;
}
