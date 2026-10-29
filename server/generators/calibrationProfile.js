// Calibration profiles adjust the generator's built-in distributions to match
// an imported dataset. This module only validates and applies them; computing a
// profile from staged data lives in server/importers/calibration.js.
import { HttpError } from '../http.js';
import { STATES } from './reference-data.js';

export const PAYMENT_METHODS = ['credit_card', 'boleto', 'pix', 'voucher', 'debit_card'];
const CODE_RE = /^[a-z0-9_]{1,80}$/;

// Validates a calibration object received from the browser inside a generation
// config. Unknown keys are dropped and every value is range-checked.
export function sanitizeCalibration(c) {
  if (c == null) return null;
  if (typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, 'calibration must be an object');
  const errors = [];
  const num = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) errors.push(`calibration.${name}: number between ${lo} and ${hi}`);
    return n;
  };
  const cats = Array.isArray(c.categories) ? c.categories.slice(0, 400) : [];
  const categories = cats
    .filter((x) => x && CODE_RE.test(String(x.code)))
    .map((x) => ({ code: String(x.code), weight: num(x.weight, 0, 1, 'categories.weight'), medianPrice: num(x.medianPrice, 0.5, 100000, 'categories.medianPrice') }));
  const paymentMix = {};
  for (const m of PAYMENT_METHODS) paymentMix[m] = num(c.paymentMix?.[m] ?? 0, 0, 1, `paymentMix.${m}`);
  if (PAYMENT_METHODS.every((m) => !(paymentMix[m] > 0))) errors.push('calibration.paymentMix: at least one method needs a weight');
  const states = (obj, name) => {
    const out = {};
    for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) if (Object.hasOwn(STATES, k)) out[k] = num(v, 0, 1, `${name}.${k}`);
    return out;
  };
  const result = {
    source: String(c.source || 'custom').replace(/[^\w.-]/g, '').slice(0, 40),
    categories,
    paymentMix,
    customerStates: states(c.customerStates, 'customerStates'),
    sellerStates: states(c.sellerStates, 'sellerStates'),
  };
  if (errors.length) throw new HttpError(400, 'Invalid calibration', errors);
  return result;
}

// Rescales leaf categories and location weights in place.
export function applyCalibration(cal, leaves, locations) {
  const byCode = new Map(cal.categories.map((c) => [c.code, c]));
  if (leaves.some((l) => byCode.has(l.code))) {
    for (const l of leaves) {
      const c = byCode.get(l.code);
      if (c) {
        l.weight = Math.max(c.weight, 1e-6);
        l.price = c.medianPrice;
      } else {
        l.weight *= 1e-4;
      }
    }
  }
  for (const [field, key] of [['customerWeight', 'customerStates'], ['sellerWeight', 'sellerStates']]) {
    const shares = cal[key];
    if (!Object.keys(shares).length) continue;
    const stateSum = {};
    for (const l of locations) stateSum[l.state] = (stateSum[l.state] || 0) + l[field];
    for (const l of locations) {
      const s = shares[l.state];
      l[field] = s > 0 && stateSum[l.state] > 0 ? (l[field] / stateSum[l.state]) * s : l[field] * 1e-4;
    }
  }
}

export function paymentWeights(cal) {
  return PAYMENT_METHODS.map((m) => cal.paymentMix[m] || 0);
}
