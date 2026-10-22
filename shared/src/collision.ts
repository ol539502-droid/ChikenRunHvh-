export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Width of the broad-phase grid cells (raycastWorld walks them). */
export const CELL_SIZE = 4;
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
  /** Player clips: boxes that stop chickens but not bullets or sight (Mirage's invisible gap fillers). */
  readonly seeThrough = new Set<number>();
  /** Bumped by every add and remove, so a cached trace can tell the world changed. */
  revision = 0;
  /** Climbable ladder volumes (Mirage). */
  ladders: readonly Aabb[] = [];

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
    this.revision++;
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
    this.revision++;
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

  /** The ids registered in grid cell (cx, cz) (cells are CELL_SIZE wide), in no particular order. */
  cellIds(cx: number, cz: number): readonly number[] | undefined {
    return this.cells.get(cellKey(cx, cz));
  }

  /** Ids of the boxes whose grid cells touch the XZ rectangle, ascending (the same order as entries()). */
  idsNear(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    const ids: number[] = [];
    this.forEachCell(minX, minZ, maxX, maxZ, (key) => {
      const list = this.cells.get(key);
      if (list) for (const id of list) ids.push(id);
    });
    ids.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[i - 1]) ids[n++] = ids[i]!;
    ids.length = n;
    return ids;
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
