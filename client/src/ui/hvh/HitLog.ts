import { formatVerdict, type ShotVerdict } from '@game/shared/hvh/v2';
import { clear, h } from '../dom';

export interface HitLogEntry {
  text: string;
  timestamp: number;
}

export interface HitLogModelOptions {
  maxLines?: number;
  fadeMs?: number;
  now: () => number;
}

export class HitLogModel {
  readonly maxLines: number;
  readonly fadeMs: number;
  private readonly now: () => number;
  private entries: HitLogEntry[] = [];

  constructor(options: HitLogModelOptions) {
    this.maxLines = options.maxLines ?? 8;
    this.fadeMs = options.fadeMs ?? 5000;
    this.now = options.now;
  }

  push(text: string): void {
    const timestamp = this.now();
    this.entries.push({ text, timestamp });
    if (this.entries.length > this.maxLines) {
      this.entries.splice(0, this.entries.length - this.maxLines);
    }
  }

  visibleLines(): readonly HitLogEntry[] {
    const current = this.now();
    return this.entries.filter((e) => current - e.timestamp < this.fadeMs);
  }

  get lines(): readonly string[] {
    return this.visibleLines().map((e) => e.text);
  }

  clear(): void {
    this.entries = [];
  }
}

export interface HitLogOptions {
  now?: () => number;
  container?: HTMLElement;
  maxLines?: number;
  fadeMs?: number;
}

export class HitLog {
  readonly model: HitLogModel;
  readonly nameOf: (id: string) => string;
  readonly root?: HTMLElement;

  constructor(nameOf: (id: string) => string, options?: HitLogOptions) {
    this.nameOf = nameOf;
    const now = options?.now ?? (() => performance.now());
    this.model = new HitLogModel({
      maxLines: options?.maxLines,
      fadeMs: options?.fadeMs,
      now,
    });

    if (typeof document !== 'undefined') {
      this.root = h('div', {
        class: 'hvh-hitlog',
        style:
          'position:absolute;top:12px;left:12px;display:flex;flex-direction:column;gap:3px;font-family:monospace;font-size:12px;font-weight:600;color:#e8e8e8;text-shadow:1px 1px 1px #000;pointer-events:none;z-index:30;',
      });
      if (options?.container) options.container.append(this.root);
    }
  }

  push(v: ShotVerdict): void {
    const text = formatVerdict(v, this.nameOf);
    this.model.push(text);
    this.render();
  }

  get lines(): readonly string[] {
    return this.model.lines;
  }

  setVisible(visible: boolean): void {
    if (this.root) this.root.hidden = !visible;
  }

  render(): void {
    if (!this.root) return;
    clear(this.root);
    for (const entry of this.model.visibleLines()) {
      this.root.append(h('div', { class: 'hvh-hitlog-line' }, entry.text));
    }
  }

  update(): void {
    this.render();
  }

  dispose(): void {
    this.root?.remove();
  }
}

/**
 * Lazily creates the HitLog on the first v2 hvhState event and registers the shotVerdict listener.
 * In legacy rooms and non-HvH rooms where hvhState never arrives, this is never called.
 * Verdicts that arrive before the first hvhState are dropped because hitLog is null until then.
 */
export function initHvhV2Ui(
  target: { hitLog: HitLog | null },
  create: () => HitLog,
  registerShotVerdict: (handler: (v: ShotVerdict) => void) => void,
): boolean {
  if (target.hitLog !== null) return false;
  target.hitLog = create();
  registerShotVerdict((v) => target.hitLog?.push(v));
  return true;
}
