/**
 * Python's random.Random, exactly: the Mersenne Twister seeded from an int, random(), uniform() and choice(). The
 * demo person's made-up history comes from Random(2026), and it has to be the same history the Python app made.
 */

export class PyRandom {
  private mt = new Uint32Array(624);
  private i = 625;

  constructor(seed: number) {
    // Python seeds an int through init_by_array with its 32-bit words (one word here).
    this.initByArray([seed >>> 0]);
  }

  private initGenrand(s: number) {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.i = 624;
  }

  private initByArray(key: number[]) {
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = ((this.mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = ((this.mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
  }

  private uint32(): number {
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (this.mt[k] & 0x80000000) | (this.mt[(k + 1) % 624] & 0x7fffffff);
        this.mt[k] = this.mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = this.mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53 random bits in [0, 1). */
  random(): number {
    const a = this.uint32() >>> 5, b = this.uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  private getrandbits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** random.choice(seq), through _randbelow as Python does it. */
  choice<T>(seq: T[]): T {
    const n = seq.length, k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return seq[r];
  }
}
