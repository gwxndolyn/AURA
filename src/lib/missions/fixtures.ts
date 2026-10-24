/**
 * Fixture for the "checkout-fix" showcase mission: a small, real checkout
 * module with a real defect and a real test suite. The sandbox runs these
 * files with `node --test`, so pass/fail results are genuine.
 *
 * Three implementations exist so the engine can exercise its bounded repair
 * loop honestly:
 *   BUGGY   — current code: float math + Math.floor (undercharges by a cent).
 *   PARTIAL — first repair attempt: switches floor → round. Fixes the cent bug
 *             but still accepts negative quantities, so one test still fails.
 *   FIXED   — second repair attempt: integer-cent arithmetic + quantity
 *             validation. All tests pass.
 *
 * In simulation mode (no API key) the engineer agent's code edits are these
 * deterministic candidates, not model-written code; the mission report says so.
 */

export const CHECKOUT_FILE = "src/checkout/checkout.js";
export const CHECKOUT_TEST_FILE = "src/checkout/checkout.test.js";
export const MODULE_FILE = "checkout.js";

export const CHECKOUT_BUGGY = "// Checkout totals for the NOVA PAY storefront.\nfunction lineTotal(item) {\n  return item.unitPrice * item.quantity;\n}\nfunction subtotal(items) {\n  return items.reduce((sum, it) => sum + lineTotal(it), 0);\n}\nfunction applyDiscount(amount, code) {\n  if (code === \"SAVE10\") return amount * 0.9;\n  return amount;\n}\nfunction total(items, opts = {}) {\n  const sub = applyDiscount(subtotal(items), opts.discountCode);\n  const tax = sub * (opts.taxRate ?? 0);\n  return sub + tax;\n}\nfunction chargeAmountCents(items, opts = {}) {\n  // Payment provider requires an integer amount in cents.\n  return Math.floor(total(items, opts) * 100);\n}\nmodule.exports = { lineTotal, subtotal, applyDiscount, total, chargeAmountCents };\n";

export const CHECKOUT_PARTIAL = "// Checkout totals for the NOVA PAY storefront.\nfunction lineTotal(item) {\n  return item.unitPrice * item.quantity;\n}\nfunction subtotal(items) {\n  return items.reduce((sum, it) => sum + lineTotal(it), 0);\n}\nfunction applyDiscount(amount, code) {\n  if (code === \"SAVE10\") return amount * 0.9;\n  return amount;\n}\nfunction total(items, opts = {}) {\n  const sub = applyDiscount(subtotal(items), opts.discountCode);\n  const tax = sub * (opts.taxRate ?? 0);\n  return sub + tax;\n}\nfunction chargeAmountCents(items, opts = {}) {\n  // Payment provider requires an integer amount in cents.\n  return Math.round(total(items, opts) * 100);\n}\nmodule.exports = { lineTotal, subtotal, applyDiscount, total, chargeAmountCents };\n";

export const CHECKOUT_FIXED = "// Checkout totals for the NOVA PAY storefront.\n// All arithmetic is done in integer cents; floats are converted once at the edge.\nfunction toCents(amount) {\n  return Math.round(Number(amount) * 100);\n}\nfunction lineTotalCents(item) {\n  if (!Number.isInteger(item.quantity) || item.quantity < 1) {\n    throw new RangeError(`invalid quantity: ${item.quantity}`);\n  }\n  return toCents(item.unitPrice) * item.quantity;\n}\nfunction subtotalCents(items) {\n  return items.reduce((sum, it) => sum + lineTotalCents(it), 0);\n}\nfunction applyDiscountCents(cents, code) {\n  if (code === \"SAVE10\") return Math.round(cents * 0.9);\n  return cents;\n}\nfunction chargeAmountCents(items, opts = {}) {\n  // Payment provider requires an integer amount in cents.\n  const sub = applyDiscountCents(subtotalCents(items), opts.discountCode);\n  return Math.round(sub * (1 + (opts.taxRate ?? 0)));\n}\nmodule.exports = { toCents, lineTotalCents, subtotalCents, applyDiscountCents, chargeAmountCents };\n";

export const CHECKOUT_TESTS = "const test = require('node:test');\nconst assert = require('node:assert');\nconst c = require('./checkout.js');\n\ntest('charges 29 cents for a $0.29 item (reported: customer charged 28)', () => {\n  assert.strictEqual(c.chargeAmountCents([{ unitPrice: 0.29, quantity: 1 }]), 29);\n});\ntest('charges $1.15 x 1 as 115 cents', () => {\n  assert.strictEqual(c.chargeAmountCents([{ unitPrice: 1.15, quantity: 1 }]), 115);\n});\ntest('applies SAVE10 before tax and rounds to the nearest cent', () => {\n  const cart = [{ unitPrice: 19.99, quantity: 3 }, { unitPrice: 4.1, quantity: 1 }];\n  assert.strictEqual(c.chargeAmountCents(cart, { discountCode: 'SAVE10', taxRate: 0.0825 }), 6242);\n});\ntest('always returns an integer number of cents', () => {\n  const cents = c.chargeAmountCents([{ unitPrice: 19.99, quantity: 3 }], { taxRate: 0.07 });\n  assert.ok(Number.isInteger(cents));\n});\ntest('rejects a negative quantity instead of issuing a refund through checkout', () => {\n  assert.throws(() => c.chargeAmountCents([{ unitPrice: 5, quantity: -1 }]), /quantity/);\n});\n";

/** Ordered repair candidates the engineer tries, one per repair attempt. */
export const REPAIR_CANDIDATES = [
  { label: "Round to nearest cent instead of flooring", code: CHECKOUT_PARTIAL },
  { label: "Integer-cent arithmetic + quantity validation", code: CHECKOUT_FIXED },
];

export const BUG_REPORT =
  "Support ticket #4471: a customer buying a single $0.29 sticker was charged $0.28. " +
  "Finance also flagged a negative-quantity order that produced a refund through checkout.";
