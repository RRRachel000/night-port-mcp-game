export function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x6d2b79f5;
}

export class SeededRandom {
  private currentState: number;

  constructor(seed: number, state?: number) {
    this.currentState = (state ?? seed) >>> 0 || 0x6d2b79f5;
  }

  get state(): number {
    return this.currentState >>> 0;
  }

  next(): number {
    let value = this.currentState += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const result = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    this.currentState >>>= 0;
    return result;
  }

  integer(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer");
    }
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.integer(items.length)];
    if (item === undefined) {
      throw new Error("Cannot pick from an empty collection");
    }
    return item;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.integer(index + 1);
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
    return result;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    if (count > items.length) {
      throw new Error("Sample count exceeds collection size");
    }
    return this.shuffle(items).slice(0, count);
  }
}

