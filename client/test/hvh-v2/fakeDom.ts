/** The few DOM methods the HUD and panel builders use; layout still needs a browser check. */
export class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = '';
  hidden = false;
  textContent = '';
  disabled = false;
  checked = false;
  value = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, (e?: unknown) => void> = {};
  style = { setProperty() {} };
  dataset: Record<string, string> = {};
  classList = {
    add: (c: string) => { if (!this.classes().includes(c)) this.className = [...this.classes(), c].join(' '); },
    remove: (c: string) => { this.className = this.classes().filter((x) => x !== c).join(' '); },
    toggle: (c: string, on?: boolean) => { if (on ?? !this.classes().includes(c)) this.classList.add(c); else this.classList.remove(c); },
    contains: (c: string) => this.classes().includes(c),
  };
  constructor(readonly tagName: string) {}
  private classes(): string[] { return this.className.split(/\s+/).filter(Boolean); }
  private adopt(c: FakeElement | string): FakeElement | null {
    if (typeof c === 'string') { this.textContent += c; return null; }
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    c.parent = this;
    return c;
  }
  append(...children: (FakeElement | string)[]): void { for (const c of children) { const e = this.adopt(c); if (e) this.children.push(e); } }
  prepend(...children: (FakeElement | string)[]): void { for (const c of children.reverse()) { const e = this.adopt(c); if (e) this.children.unshift(e); } }
  replaceChildren(...children: (FakeElement | string)[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.textContent = '';
    this.append(...children);
  }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  setAttribute(k: string, v: string): void { this.attributes[k] = v; }
  getAttribute(k: string): string | null { return this.attributes[k] ?? null; }
  addEventListener(k: string, fn: (e?: unknown) => void): void { this.listeners[k] = fn; }
  getContext(): object { return {}; }
  /** This element and every descendant, depth first. */
  all(): FakeElement[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  /** Descendants with this class. */
  find(cls: string): FakeElement[] { return this.all().filter((e) => e.classList.contains(cls)); }
  /** All text in this element and its descendants. */
  text(): string { return [this.textContent, ...this.children.map((c) => c.text())].join(''); }
}

/** Runs `fn` with a fake `document` whose `#hud-layer` is the returned root. */
export function withFakeDom<T>(fn: (root: FakeElement) => T): T {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const root = new FakeElement('div'), body = new FakeElement('body');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tag: string) => new FakeElement(tag), createTextNode: (s: string) => s, getElementById: (id: string) => (id === 'hud-layer' ? root : null), body },
  });
  try {
    return fn(root);
  } finally {
    if (old) Object.defineProperty(globalThis, 'document', old);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}
