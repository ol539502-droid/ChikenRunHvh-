export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const CELL_SIZE = 4;
const CELL_OFFSET = 1024;

function cellKey(cx: number, cz: number): number {
  return (cx + CELL_OFFSET) * 4096 + (cz + CELL_OFFSET);
}

/**
 * The solid boxes of a level (static map boxes plus blocks placed at runtime), with a uniform
 * grid so collision queries only look at nearby boxes.
 *
 * Query results are always in ascending id order. Physics resolves overlaps in that order,
 * so client and server must agree on it to stay deterministic.
 */
export class CollisionWorld {
  readonly halfSize: number;
  private readonly boxes = new Map<number, Aabb>();
  private readonly cells = new Map<number, number[]>();
  private readonly scratchIds: number[] = [];

  constructor(halfSize: number, staticBoxes: readonly Aabb[] = []) {
    this.halfSize = halfSize;
    staticBoxes.forEach((box, i) => this.add(i, box));
  }

  get size(): number {
    return this.boxes.size;
  }

  get(id: number): Aabb | undefined {
    return this.boxes.get(id);
  }

  all(): IterableIterator<Aabb> {
    return this.boxes.values();
  }

  entries(): IterableIterator<[number, Aabb]> {
    return this.boxes.entries();
  }

  add(id: number, box: Aabb): void {
    if (this.boxes.has(id)) this.remove(id);
    this.boxes.set(id, box);
    this.forEachCell(box.minX, box.minZ, box.maxX, box.maxZ, (key) => {
      const list = this.cells.get(key);
      if (!list) {
        this.cells.set(key, [id]);
        return;
      }
      list.push(id);
    });
  }

  remove(id: number): boolean {
    const box = this.boxes.get(id);
    if (!box) return false;
    this.boxes.delete(id);
    this.forEachCell(box.minX, box.minZ, box.maxX, box.maxZ, (key) => {
      const list = this.cells.get(key);
      if (!list) return;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.cells.delete(key);
    });
    return true;
  }

  /** Fills `out` with the boxes whose grid cells touch the XZ rectangle, in ascending id order. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Aabb[]): Aabb[] {
    out.length = 0;
    const ids = this.scratchIds;
    ids.length = 0;
    this.forEachCell(minX, minZ, maxX, maxZ, (key) => {
      const list = this.cells.get(key);
      if (list) for (const id of list) ids.push(id);
    });
    if (ids.length > 1) ids.sort((a, b) => a - b);
    let last = -1;
    for (const id of ids) {
      if (id === last) continue;
      last = id;
      out.push(this.boxes.get(id)!);
    }
    return out;
  }

  private forEachCell(minX: number, minZ: number, maxX: number, maxZ: number, fn: (key: number) => void): void {
    const cx0 = Math.floor(minX / CELL_SIZE);
    const cx1 = Math.floor(maxX / CELL_SIZE);
    const cz0 = Math.floor(minZ / CELL_SIZE);
    const cz1 = Math.floor(maxZ / CELL_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) fn(cellKey(cx, cz));
    }
  }
}
