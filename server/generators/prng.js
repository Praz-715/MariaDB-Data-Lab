// Deterministic random number generation. Every entity gets its own generator,
// seeded from (job seed, stream, entity id), so any entity can be regenerated in
// isolation: chunks can run in any order, on any worker, and on resume, and still
// produce identical rows.

export function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hash3(seed, stream, id) {
  const lo = id >>> 0;
  const hi = Math.floor(id / 4294967296) >>> 0;
  let h = mix32(seed ^ 0x9e3779b9);
  h = mix32(h ^ Math.imul(stream + 1, 0x85ebca6b));
  h = mix32(h ^ lo);
  return mix32(h ^ Math.imul(hi + 1, 0xc2b2ae35));
}

// sfc32: small, fast, and good enough statistical quality for synthetic data.
export class Rng {
  constructor(seed, stream = 0, id = 0) {
    const h = hash3(seed >>> 0, stream, id);
    this.a = h;
    this.b = mix32(h ^ 0x6a09e667);
    this.c = mix32(h ^ 0xbb67ae85);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return t >>> 0;
  }

  next() {
    return this.nextU32() / 4294967296;
  }

  // Integer in [min, max] inclusive.
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  between(min, max) {
    return min + this.next() * (max - min);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // Index into a cumulative-weight array (Float64Array or array, last = total).
  weighted(cdf) {
    const target = this.next() * cdf[cdf.length - 1];
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] > target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  normal() {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  lognormal(median, sigma) {
    return median * Math.exp(sigma * this.normal());
  }

  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  // Power-law rank in [0, n): rank 0 is the most popular.
  zipfRank(n, s) {
    if (n <= 1) return 0;
    const u = this.next();
    let x;
    if (Math.abs(s - 1) < 1e-9) x = Math.pow(n, u);
    else x = Math.pow((Math.pow(n, 1 - s) - 1) * u + 1, 1 / (1 - s));
    return Math.min(n - 1, Math.max(0, Math.floor(x) - 1));
  }
}

export function cumulative(weights) {
  const cdf = new Float64Array(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    cdf[i] = acc;
  }
  return cdf;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function mulmod(a, b, n) {
  if (a * b < Number.MAX_SAFE_INTEGER) return (a * b) % n;
  return Number((BigInt(a) * BigInt(b)) % BigInt(n));
}

// Bijection between popularity rank and entity id (both 0-based), so that popular
// entities are scattered across the id range instead of being ids 1, 2, 3...
export class Permutation {
  constructor(n, seed, stream) {
    this.n = n;
    if (n <= 1) {
      this.a = 1;
      this.b = 0;
      this.aInv = 1;
      return;
    }
    let a = Math.floor(n * 0.6180339887) | 1;
    while (gcd(a, n) !== 1) a++;
    this.a = a % n;
    this.b = hash3(seed, stream, n) % n;
    this.aInv = Number(modInverse(BigInt(this.a), BigInt(n)));
  }

  rankToIndex(rank) {
    return (mulmod(rank, this.a, this.n) + this.b) % this.n;
  }

  indexToRank(index) {
    return mulmod((index - this.b + this.n) % this.n, this.aInv, this.n);
  }
}

function modInverse(a, n) {
  let [oldR, r] = [a, n];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % n) + n) % n;
}
