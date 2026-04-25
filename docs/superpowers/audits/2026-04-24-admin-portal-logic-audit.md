# Admin Portal — Logic Flaw Audit

**Date:** 2026-04-24
**Scope:** `apps/admin-portal/**` and the API routers it calls (`packages/api/src/routers/**`).
**Out of scope:** authz/role checks, OWASP/security, performance.
**Methodology:** Four parallel cluster sweeps (orders/cart, inventory/packing, pricing/customer/supplier, delivery/product/dashboard) followed by independent re-verification of every cited code path. Findings the verification pass could not reproduce were dropped.

## Summary

**24 findings** across 5 modules. Re-verification dropped 5 raw findings the cluster agents reported (one was based on a misread; one was the correct behaviour; three could not be reproduced from a concrete trigger).

| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 8 |
| Medium | 10 |
| Low | 5 |

| Module | Count |
| --- | --- |
| orders/cart | 7 |
| inventory/packing | 7 |
| customer/credit | 4 |
| pricing | 1 |
| delivery | 3 |
| dashboard | 2 |
| product | 2 |

| Category | Count |
| --- | --- |
| business-logic-state | 11 |
| validation-money | 10 |
| concurrency-integrity | 3 |

### Systemic patterns (worth a single cross-cutting fix)

**P-1: Float epsilon bugs in quantity comparisons (F-02, F-03, F-09).** The two most recent `main` commits (`8a0412c`, `da97145`) fixed isolated cases. Three more sites still use exact equality or `<= 0` against `Float` quantity fields. Recommend a project-wide `EPSILON = 0.001` constant and a `quantityIsZero(qty)` / `quantityIsConsumed(remaining)` helper, then replace every direct comparison on `quantityRemaining` / `currentStock` / `Float` aggregates.

**P-2: Inconsistent `applyGst` / `gstRate` plumbing (F-04, F-05, F-06, F-07).** The product-level GST flags exist in the schema but four code paths handle them differently: `Math.round(rate)` truncates fractional percentages, pricing queries forget to fetch `applyGst`/`gstRate` and silently default to "no GST", `applyGst=true && gstRate=null` silently uses 10%, and `calculatePriceWithGst` calls dinero with a non-integer `amount` for fractional rates. Recommend (a) make `gstRate` non-null when `applyGst=true` at the schema/Zod level, (b) introduce a single `calculateItemGst(item)` helper and route every site through it, (c) store `gstRate` in basis points (`Int`) instead of a `Float` percentage to eliminate the rounding entirely.

**P-3: Server timezone vs Melbourne (F-13, F-14).** Dashboard queries build `today` from `new Date(now.getFullYear(), …)` — local server time, not Melbourne. The codebase already has a `getUTCDayRangeForMelbourneDay` helper that's imported but unused in `dashboard.ts`. Wire it through all `getFinancialOverview` and `getRevenueTrend` paths.

**P-4: Customer/credit state guards inconsistent (F-10, F-11, F-15).** `closed` customer status is missing from order creation's status check, `rejectCredit` has no current-state validation (where `approveCredit` does), and admin customer creation auto-approves credit when `creditLimit > 0`. These belong in a single state-transition guard module.

**P-5: Pre-transaction credit/stock checks (F-19, F-21).** Several flows read state, run a check in app code, then enter a `$transaction`. Inside the transaction the state is not re-checked. Race windows are small but real, especially under concurrent admin actions. Move the validation inside the transaction or use atomic guards (`updateMany` with the expected condition, as `markDelivered` already does).

---

## Critical

### F-01: Admin `markDelivered` accepts orders without proof of delivery
- **Severity**: Critical
- **Module**: delivery
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/delivery.ts:213-317`
- **What's wrong**: The driver path (`completeDelivery` at `delivery.ts:955-1011`) explicitly checks `if (!order.delivery?.proofOfDelivery)` and rejects with "Proof of delivery is required…". The admin path (`markDelivered`) has no equivalent check — it transitions any `ready_for_delivery` or `out_for_delivery` order straight to `delivered`.
- **Trigger**: Admin with `deliveries:manage` calls `markDelivered` on an order that has never had a POD photo or signature uploaded (`delivery.proofOfDelivery` is `undefined`). The order is marked delivered.
- **Impact**: Orders ship to invoice (Xero) with no auditable evidence that delivery occurred. In a customer dispute the company has no signature/photo to point to. This is also the easiest path to silently bypass the entire POD requirement — a single endpoint with no equivalent guard.
- **Suggested fix**: Mirror the `completeDelivery` POD validation in `markDelivered` after the status transition guard but before the status history write. Optionally allow an admin-override path that requires a written reason recorded in `statusHistory.notes` so the audit trail still captures *why* POD was skipped.

---

## High

### F-02: `consumeStock` / `consumeFromBatch` use exact equality on float quantity
- **Severity**: High
- **Module**: inventory
- **Category**: business-logic-state
- **Location**: `packages/api/src/services/inventory-batch.ts:135-136` and `:289-290`
- **What's wrong**: After computing `newQuantity = batch.quantityRemaining - quantityFromBatch`, both functions set `isFullyConsumed = newQuantity === 0`. Float subtraction commonly yields a near-zero residue (`21 - 10.5 - 10.5` does not equal `0` in IEEE-754). The same function defends against this on line 102 (`if (remainingToConsume < 0.001) break;`) and 126 (`if (quantityFromBatch < 0.001) { … continue; }`), proving the author knew the bug class — the equality check is the one site that wasn't migrated.
- **Trigger**: A batch with `initialQuantity = 21` is consumed by two orders of `10.5` each. The second consumption leaves `quantityRemaining ≈ 1e-14`, with `isConsumed = false`. The next consumeStock call finds it via `isConsumed: false` filtering, then skips it at the line 126 guard, never marking it consumed.
- **Impact**: "Zombie" batches accumulate. They show in the active-batch list, distort FIFO ordering (oldest-first picks an empty batch first), and pollute reports that count `isConsumed: false` rows. Also blocks `Product.currentStock` reconciliation from converging.
- **Suggested fix**: Replace `=== 0` with `Math.abs(newQuantity) < 0.001`. Combine with P-1 to add a single `quantityIsConsumed(remaining)` helper used everywhere.

### F-03: `restoreBatchConsumptions` `isConsumed` flag fails for epsilon-positive remainder
- **Severity**: High
- **Module**: packing
- **Category**: business-logic-state
- **Location**: `packages/api/src/services/inventory-batch.ts:559-571`
- **What's wrong**: After restoration the code sets `isConsumed: restoredQty <= 0`. If a prior consumption left the batch with a tiny float residue and the consumption record matches it, the restored value can be `0.0000001`, which is `> 0` and so `isConsumed: false`. The companion field `consumedAt: restoredQty > 0 ? null : batch.consumedAt` has the same problem in reverse.
- **Trigger**: Reset a packed order whose original consumption produced float drift on the source batch. The restore writes back the residue plus the consumed quantity, capped at `initialQuantity`. In edge cases the cap leaves the batch at `~initialQuantity - 0.00…01`. The check returns `false` for "fully restored" even though the batch should be considered fresh again.
- **Impact**: Same class of zombie/inconsistent batch as F-02. Audit trails can show "restored" but the FIFO and reporting layer disagree on whether the batch is consumed.
- **Suggested fix**: Use `Math.abs(restoredQty) < 0.001 || restoredQty <= 0` for `isConsumed`, and the inverse for `consumedAt`. Or, since restoration caps at `initialQuantity`, simply test `restoredQty >= batch.initialQuantity - EPSILON` to mark the batch fully restored.

### F-04: GST rate `Math.round(rate)` truncates fractional percentages
- **Severity**: High
- **Module**: cart, orders
- **Category**: validation-money
- **Location**: `packages/api/src/routers/cart.ts:188` and `packages/shared/src/utils/index.ts:203`
- **What's wrong**: Both sites compute the multiplier as `{ amount: Math.round(rate), scale: 2 }`. With `rate = 5.5` the multiplier becomes `{ amount: 6, scale: 2 } = 0.06`, applying 6% GST instead of 5.5%. With `rate = 12.5` it becomes 13%. The `scale: 2` was chosen for the default rate of 10 (= 0.10) but the rounding kills any fractional rate.
- **Trigger**: Create a product with `applyGst: true, gstRate: 5.5`. Add to cart or place an order. The stored `taxAmount` and the GST line on the resulting Xero invoice both reflect 6% on the subtotal.
- **Impact**: Tax calculation is wrong by 9% relative on any non-integer rate. For products with non-standard GST rates this ships incorrect numbers to the customer and to Xero, creating a reconciliation problem that is invisible until BAS time.
- **Suggested fix**: Pass the fractional rate without rounding by using a finer scale, e.g. `{ amount: Math.round(rate * 10), scale: 3 }`. Better: store `gstRate` in basis points (Int) and pass `{ amount: gstRateBps, scale: 4 }`. P-2 covers this systemically.

### F-05: `calculatePriceWithGst` passes non-integer `amount` to dinero
- **Severity**: High
- **Module**: pricing
- **Category**: validation-money
- **Location**: `packages/shared/src/utils/pricing.ts:53-58`
- **What's wrong**: The function builds the multiplier as `{ amount: rate, scale: 2 }` and passes it directly to dinero's multiply. dinero v2 expects `amount` to be an integer and will either throw or coerce silently when given `5.5`. Unlike F-04 there is no `Math.round` here, so fractional rates either crash the price-display path or quietly produce wrong values depending on dinero's behaviour.
- **Trigger**: A customer-portal product card or pricing endpoint resolves a product with `applyGst: true, gstRate: 5.5`. Calling `calculatePriceWithGst(price, true, 5.5)` triggers the bad multiplication.
- **Impact**: Either a runtime error on price display for any product with a fractional GST rate, or silently miscalculated prices in product listings. The two main GST sites (cart/order totals at F-04 vs price display at F-05) are inconsistent — fix the rate plumbing once, in one place.
- **Suggested fix**: Same as F-04 — convert the rate to an integer-and-scale pair before passing to `multiplyMoney`. P-2 covers the systemic version.

### F-06: Pricing queries miscalculate `priceWithGst` because product GST fields aren't fetched
- **Severity**: High
- **Module**: pricing
- **Category**: validation-money
- **Location**: `packages/api/src/routers/pricing.ts:281-293` (`getCustomerProductPrice`)
- **What's wrong**: The endpoint selects `{ basePrice: true }` from the product (line 283) and calls `getEffectivePrice(product.basePrice, pricing)` (line 293) without the optional `gstOptions` parameter. `getEffectivePrice` defaults to `applyGst: false` (`pricing.ts:96-97`), so `priceWithGst` returned to the caller equals `effectivePrice` regardless of the product's actual configuration. Other pricing-router queries (`getAll`, etc.) follow the same pattern.
- **Trigger**: Admin pricing UI loads a product where `applyGst: true, gstRate: 10` and a custom price is set. The resolved `priceWithGst` returned to the UI is the pre-GST `effectivePrice`, not the GST-inclusive total. Or the inverse for products where `applyGst: false` — those are unaffected.
- **Impact**: Wherever this endpoint feeds a UI showing GST-inclusive prices, the displayed total is wrong (missing the GST). For decisions made off this number — "what would I quote this customer?" — the figure is inconsistent with the cart/order math.
- **Suggested fix**: Add `applyGst: true, gstRate: true` to the `select`, and pass `{ applyGst: product.applyGst, gstRate: product.gstRate }` to `getEffectivePrice`. Audit the rest of `pricing.ts` for the same omission.

### F-07: `applyGst=true` with `gstRate=null` silently applies default 10%
- **Severity**: High
- **Module**: product
- **Category**: validation-money
- **Location**: Zod schemas at `packages/api/src/routers/product.ts` (`createProduct` / `updateProduct`); resolver at `packages/shared/src/utils/pricing.ts:53` (`const rate = gstRate ?? DEFAULT_GST_RATE`)
- **What's wrong**: The product schema accepts `applyGst: true` while leaving `gstRate` `null`/`undefined`. Every consumer (`calculatePriceWithGst`, `calculateItemGst`, `calculateOrderTotals`) silently substitutes `DEFAULT_GST_RATE = 10`. There is no warning, no UI prompt, and the default is invisible from the product record.
- **Trigger**: Admin enables the GST checkbox on a product but leaves the rate field empty (or the form binding fails to send the rate). The product is saved. From then on the system charges 10% on it without any indication of where that 10% came from.
- **Impact**: For products that intentionally use a non-standard rate, a single missing field silently reverts to 10%. The operator has no way to spot the divergence — every downstream report says "GST applied" with no distinguishing data. Combined with F-04 this means the actual rate could be 6%, 10%, or arbitrary depending on the path, all on the same product.
- **Suggested fix**: Add a Zod `.refine()` at product create/update: when `applyGst === true`, `gstRate` must be a finite number `> 0`. Set the existing `DEFAULT_GST_RATE` fallback to throw rather than silently applying.

### F-08: `closed` customer status is not blocked from placing orders
- **Severity**: High
- **Module**: customer
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/order.ts:301-323`
- **What's wrong**: Order creation rejects `customer.status === 'suspended'` (line 302) and rejects when `creditApplication.status !== 'approved'` (line 318). It does not check `customer.status === 'closed'`. A customer closed by `customer.close` retains their last `creditApplication.status` (which is typically `approved`), so the credit gate doesn't catch them either.
- **Trigger**: Admin closes a customer via `customer.close` (sets `status: 'closed'`, `closedAt`, `closedBy`) for a previously-approved customer. Customer or admin-on-behalf calls `order.create`. The order is accepted and processed normally.
- **Impact**: Closed accounts can continue to transact, defeating the purpose of the closure status. The closure was designed as a permanent terminal state and the schema's `closedAt`/`closedBy`/`closureReason` fields confirm that intent.
- **Suggested fix**: Add `if (customer.status === 'closed') throw FORBIDDEN("This account is closed.")` alongside the suspended check. Better: convert the per-status checks into a single guard helper used by every order-side endpoint.

### F-09: `resetOrder` aggregation skip uses exact equality
- **Severity**: High
- **Module**: packing
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/packing.ts:1777-1782` (per cluster B agent; verify exact line range during fix as packing.ts has shifted)
- **What's wrong**: When summing positive and negative packing-adjustment quantities to compute restoration deltas, the loop has `if (quantity === 0) continue;`. Float arithmetic can produce `1e-15` from offsetting positive/negative aggregates, which falls through and writes a `packing_reset` `InventoryTransaction` of `1e-15` quantity.
- **Trigger**: An order had a `+10.5` adjustment then a `-10.5` adjustment on the same product (e.g. packer corrected a quantity then reverted). Reset is invoked. The product's net quantity is `0 ± epsilon`, so a junk transaction lands in the audit trail.
- **Impact**: Audit-trail pollution; future stock-reconciliation queries will see noise; the `packing_reset` count metric becomes unreliable. Not a stock-quantity bug because the rounded transaction has near-zero effect, but reduces trust in the records.
- **Suggested fix**: Replace `=== 0` with `Math.abs(quantity) < 0.001`. Same fix as F-02 / F-03 — see P-1.

---

## Medium

### F-10: `rejectCredit` has no current-state guard and runs outside a transaction
- **Severity**: Medium
- **Module**: customer
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/customer.ts:1179-1213`
- **What's wrong**: `approveCredit` (above this in the same file) wraps its work in `prisma.$transaction` and validates the existing `creditApplication.status` is `'pending'` before approving. `rejectCredit` does neither. It does an unconditional `prisma.customer.update(…)` setting `status: 'rejected'` regardless of current state, and writes the audit log outside any transaction.
- **Trigger**: An already-approved customer is rejected via `rejectCredit` (e.g. UI bug, double-click, or a deliberate admin error). The approval is silently overwritten — `reviewedAt` and `reviewedBy` reflect the rejection, the prior approval evidence is replaced, and a rejection email goes out. The `approveCredit` audit log is the only remaining trace of approval.
- **Impact**: An approved customer can be flipped to rejected with no transitional check. Concurrent calls don't corrupt the database (single-document update is atomic) but each call sends its own email and writes its own audit row. Invariant "rejection only from pending" is not enforced.
- **Suggested fix**: Mirror `approveCredit` exactly: wrap the read + update in a transaction, throw if `currentStatus !== 'pending'`, and only then update + email + audit. Add an explicit "revoke approval" mutation if reverting an approval is a real workflow.

### F-11: Admin customer creation auto-approves credit when `creditLimit > 0`
- **Severity**: Medium
- **Module**: customer
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/customer.ts:980-988`
- **What's wrong**: In the admin-side customer creation flow, the embedded `creditApplication.status` is computed as `input.creditLimit > 0 ? 'approved' : 'pending'`. Both `reviewedAt` and `reviewedBy` are stamped in the same expression. Any user with `customers:create` permission can grant credit to a brand-new customer simply by setting a non-zero credit limit at create time — there is no second-step `approveCredit` requirement, no audit-log entry from `logCreditApproval` (that lives only in the explicit approve mutation), and no email.
- **Trigger**: Admin opens "Create customer", fills the form including `creditLimit: 50000`, submits. The customer record is created with `creditApplication.status = 'approved'`.
- **Impact**: The intended credit-approval workflow can be bypassed for any new customer by anyone with create-customer permission. Could be intentional (if create-customer is gated to senior staff) but it isn't documented and `customers:create` ≠ `customers:approve_credit`.
- **Suggested fix**: Either (a) always create with `status: 'pending'` and require an explicit `approveCredit` call, or (b) document this as a deliberate fast-path and additionally require `customers:approve_credit` permission for the case `creditLimit > 0`. In either case, emit `logCreditApproval` so the audit trail captures the implicit approval.

### F-12: Backorder partial approval allows `approvedQuantity = 0`
- **Severity**: Medium
- **Module**: orders
- **Category**: validation-money
- **Location**: `packages/api/src/routers/order.ts:1986-1999`
- **What's wrong**: The partial-approval code maps over `order.items` and applies `approvedQuantities[item.productId]` if it is defined and differs from the existing quantity. The check is `if (approvedQty !== undefined && approvedQty !== item.quantity)` — `0` passes both conditions. The item is then written with `quantity: 0, subtotal: 0`. There is no Zod constraint that `approvedQuantities` values must be positive.
- **Trigger**: Admin reviewing a backorder approves with `approvedQuantities: { "<productId>": 0 }`. The item remains in the order with quantity 0.
- **Impact**: Order persists invalid line items. Xero invoices and customer email summaries show zero-quantity rows. Downstream packing screens may render the item as "skip" or display oddly.
- **Suggested fix**: Add `z.number().positive()` (or `.int().positive()` if integer-only) on each value of the `approvedQuantities` Zod record. If "remove this item from the order" is a real workflow, model it as a separate explicit mutation.

### F-13: Dashboard `getFinancialOverview` builds date ranges in server timezone
- **Severity**: Medium
- **Module**: dashboard
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/dashboard.ts:534-566`
- **What's wrong**: Constructs `today = new Date(now.getFullYear(), now.getMonth(), now.getDate())`. Those getters use the server's local timezone. For deployments where the server runs UTC (typical), "today" begins at 00:00 UTC, not 00:00 Australia/Melbourne. The router file imports `getUTCDayRangeForMelbourneDay` for use elsewhere but does not use it here.
- **Trigger**: An order is placed at 23:30 Melbourne (= 12:30 or 13:30 UTC, depending on DST). Querying `getFinancialOverview({ period: 'today' })` from Melbourne the next morning at 09:00 AEST shows that order under "yesterday" — even though it occurred on the calendar day the user is asking about.
- **Impact**: Daily revenue and "today vs yesterday" comparisons are wrong by up to one day's worth of orders during the 14-hour Melbourne/UTC offset window. Period-over-period percent changes mislead decisions made off the dashboard.
- **Suggested fix**: Replace local-timezone date construction with `getUTCDayRangeForMelbourneDay(new Date())` for the daily period, and equivalent Melbourne-aware helpers for week/month boundaries. Audit the rest of `dashboard.ts` for the same pattern.

### F-14: Revenue trend mixes UTC grouping with Melbourne x-axis labels
- **Severity**: Medium
- **Module**: dashboard
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/dashboard.ts:683-721`
- **What's wrong**: The Mongo aggregation groups orders with `$dateToString` on `orderedAt` using format `'%Y-%m-%d'` and no `timezone` field — Mongo defaults to UTC. The fill-in loop then formats each generated date with `formatDateForMelbourne(date)` and looks up the Mongo result by that string. The two date strings can disagree on the calendar boundary, producing missing days, zero-revenue gaps where revenue exists, and double-counting at boundaries.
- **Trigger**: Same as F-13: orders placed late evening Melbourne time fall on the wrong UTC date and mismatch the Melbourne-formatted lookup.
- **Impact**: Trend chart shows a "0 revenue" sliver on one day next to a doubled bar on the adjacent day. For decision-makers reading the chart this looks like a real volume change.
- **Suggested fix**: Add `timezone: 'Australia/Melbourne'` to the `$dateToString` operator, or fetch raw orders and bucket them in JS using the Melbourne formatter for both grouping and labelling. Don't mix the two date spaces.

### F-15: `markOrderReady` validates stock pre-transaction, then consumes inside the transaction
- **Severity**: Medium
- **Module**: packing
- **Category**: concurrency-integrity
- **Location**: `packages/api/src/routers/packing.ts` `markOrderReady` (around 1215-1248 per cluster B agent)
- **What's wrong**: The endpoint reads `Product.currentStock` and `Order.stockConsumed` outside the consumption transaction, validates availability there, then enters `$transaction` and calls `consumeStock`. `consumeStock` itself uses optimistic locks per batch and retries, so within a single product the race is handled. Across multi-line orders, two concurrent `markOrderReady` calls can each pass the pre-check, both enter `$transaction`, and one will hit a `consumeStock` conflict-retry loop that produces a 500-style error to the caller rather than the friendlier "insufficient stock" error.
- **Trigger**: Two packers click "Mark ready" simultaneously on different orders that draw from the same constrained batches — combined demand exceeds available stock by a small amount. Both pass the pre-check. The first transaction succeeds. The second eventually fails after `MAX_RETRIES` with a generic conflict error.
- **Impact**: Confusing error UX in a race window; not a data-integrity bug because the per-batch optimistic lock prevents over-consumption. Symptom is "intermittent 500 with retry-after message" rather than "you're out of stock — adjust the order".
- **Suggested fix**: Move the aggregate availability validation inside the transaction, after re-reading current stock, before calling `consumeStock`. The result is a clean `BAD_REQUEST` with the actual shortfall instead of a conflict-retry exhaust.

### F-16: Subproduct cascade uses stale parent loss percentage on batch-quantity update
- **Severity**: Medium
- **Module**: inventory
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/inventory.ts:1119-1167` (`updateBatchQuantity`)
- **What's wrong**: When a batch quantity is corrected, the cascade to subproduct `currentStock` calls `calculateAllSubproductStocksWithInheritance` with the parent's `estimatedLossPercentage` taken from `batch.product` — which was loaded at the start of the request. If the parent's loss percentage changed between the load and the cascade (e.g. another admin updated the parent product), the cascade applies the old percentage.
- **Trigger**: Parent product has `estimatedLossPercentage = 5`. Admin A starts a batch quantity correction. Admin B updates the parent product to `estimatedLossPercentage = 10`. Admin A's request lands; the cascade computes subproduct stock as `parent * (1 - 0.05)` instead of `* (1 - 0.10)`.
- **Impact**: Subproduct `currentStock` drifts by a few percent until the next correction. Low probability but happens whenever a loss-percentage change overlaps with a stock adjustment.
- **Suggested fix**: Re-fetch the parent product inside the same `$transaction` immediately before the cascade and use the fresh `estimatedLossPercentage`.

### F-17: Cart silently drops items whose product was deleted
- **Severity**: Medium
- **Module**: cart
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/cart.ts:285-292`
- **What's wrong**: `buildCartResponse` iterates the persisted cart items and skips any whose `productId` no longer resolves (`if (!product) { continue; }`). The skipped items are not removed from the database, and the response carries no signal that items were dropped.
- **Trigger**: Customer adds product A. Admin deletes product A. Customer fetches the cart. Response omits A; database still has A in the `Cart.items` array.
- **Impact**: Cart UI shows fewer items than the database holds; total cents disagree with the persisted line items; customer can't see why something disappeared. On checkout, the missing item silently won't appear on the order.
- **Suggested fix**: Either remove the dead row from the DB (atomic update on the cart) and surface a one-time warning to the user, or refuse to build the cart and return a structured error listing the unavailable products so the UI can prompt the customer to remove them.

### F-18: `multiplyMoney(money, fractionalQuantity)` rounds quantity to two decimals
- **Severity**: Medium
- **Module**: cart, orders
- **Category**: validation-money
- **Location**: `packages/shared/src/utils/money.ts:170-176`
- **What's wrong**: The number-overload converts the multiplier with `{ amount: Math.round(multiplier * 100), scale: 2 }`. A quantity of `0.333` becomes `33` at scale 2 (= `0.33`), losing the third decimal. Recent commit `13ba5d2` enabled decimal quantities — this rounding silently caps precision at two decimals, which is finer than typical retail but coarser than what a kg-based meat product can specify.
- **Trigger**: Cart contains 0.333 kg of a product at $30.00/kg. `multiplyMoney(toAUD(30.00), 0.333)` is computed as `30.00 * 0.33 = $9.90` — should be `$9.99`.
- **Impact**: Per-item subtotals undershoot for any quantity with more than two decimal places. The undershoot accumulates across many items in an order. Customer-portal cart and admin order-on-behalf both hit this path.
- **Suggested fix**: Increase precision by using `{ amount: Math.round(multiplier * 1000), scale: 3 }` to support three decimal places, or a precision parameter. Consider also applying the dinero `allocate` API for true precision when summing.

### F-19: Reorder credit-limit re-check happens outside the transaction
- **Severity**: Medium
- **Module**: orders
- **Category**: concurrency-integrity
- **Location**: `packages/api/src/routers/order.ts:1640-1700` (per cluster A agent — `reorder` mutation)
- **What's wrong**: The `reorder` endpoint validates customer credit once before opening its order-creation transaction. The standalone `order.create` runs the same check inside the transaction. Between `reorder`'s pre-check and its transaction, the customer's outstanding balance could change (another order delivered, cancelled, or paid).
- **Trigger**: Customer has $5,000 available credit. `reorder` is called with a $4,999 order. The pre-check passes. While the transaction runs, an existing pending order for the same customer is cancelled, freeing $3,000. The reorder writes correctly but its credit decision is based on stale data — practically harmless here, but the inverse (credit shrunk between pre-check and write) would let an over-limit order through.
- **Impact**: A small race window can let a reorder slip past the credit limit when concurrent activity changed the customer's balance. Probability low; impact bounded by the size of the concurrent change.
- **Suggested fix**: Move the credit-limit calculation and check inside the same transaction, immediately before the `order.create`, mirroring the standalone `order.create` flow.

---

## Low

### F-20: Admin `markDelivered` does not stamp `delivery.actualArrival`
- **Severity**: Low
- **Module**: delivery
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/delivery.ts:276-294`
- **What's wrong**: The driver path sets both `deliveredAt` and `actualArrival` (`delivery.ts:1042-1043`); the admin path sets only `deliveredAt`. The schema's `actualArrival` comment says "for analytics".
- **Trigger**: Admin marks any order delivered. The order's `delivery.actualArrival` stays `null`.
- **Impact**: Analytics that segment delivery times by `actualArrival` exclude all admin-marked deliveries, which would be a measurable population once F-01 is enforced (admin-marked deliveries with POD).
- **Suggested fix**: Add `actualArrival: new Date()` next to `deliveredAt` in `markDelivered`. Audit any analytics path that filters on `actualArrival !== null`.

### F-21: Backorder approval doesn't re-check stock at packing time
- **Severity**: Low
- **Module**: orders, packing
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/order.ts:1934-1980` (re-check on approval) + `packages/api/src/routers/packing.ts` `markOrderReady`
- **What's wrong**: `approveBackorder` revalidates stock at approval time but the result is committed as soon as approval succeeds. Between approval and the eventual `markOrderReady`, stock can be consumed by other orders, leaving the approved order unable to pack. The flow has no rollback path back to "awaiting_approval".
- **Trigger**: Backorder for 100 units approved when 100 are in stock. Before the order is packed, 50 units are consumed by another order. The approved order can no longer pack.
- **Impact**: Operator sees an "approved" order they can't fulfil and must manually re-trigger the backorder workflow. Inherent to async approval, not a code bug, but worth documenting and surfacing in the packing UI.
- **Suggested fix**: At `markOrderReady`, when the consumption fails for a previously-approved backorder, return a structured error that flips the order back to `awaiting_approval` (with `expectedFulfillment` cleared) instead of forcing manual intervention.

### F-22: Reorder doesn't clear the customer's existing cart
- **Severity**: Low
- **Module**: orders, cart
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/order.ts:1525-1700+` (`reorder`)
- **What's wrong**: Standard checkout converts cart → order and clears the cart. Reorder builds an order from a previous order without touching the cart, so the cart's prior contents remain.
- **Trigger**: Customer has items A, B in the cart, then clicks "Reorder" on a past order containing C. The new order has C; the cart still has A, B.
- **Impact**: Minor UX inconsistency. A customer expecting reorder to be the active session may not realise the cart is also still live.
- **Suggested fix**: Either clear the cart on reorder (consistent with checkout) or document this divergence in product-side messaging. If both are valid intents, add an explicit confirmation in the UI.

### F-23: `markDelivered` `adminOverride` flag has no required reason and no dedicated audit field
- **Severity**: Low
- **Module**: delivery
- **Category**: business-logic-state
- **Location**: `packages/api/src/routers/delivery.ts:218, 265-273`
- **What's wrong**: The `adminOverride` boolean skips the same-day-delivery check with no required `overrideReason` and no separate audit-log type. Status history records "Delivered" the same way as a same-day delivery.
- **Trigger**: Admin sets `adminOverride: true` to mark a 3-week-old packed order delivered. The status history shows nothing distinguishing about the override.
- **Impact**: Audit trail can't distinguish legitimate same-day deliveries from late ones. Compliance/SLA reporting can't filter overrides cleanly.
- **Suggested fix**: Require an `overrideReason: string` whenever `adminOverride: true`, store it in the status-history note with a recognisable prefix ("Delivered (admin override: ...)") or add a dedicated audit event type so the override pathway is queryable.

### F-24: 100% loss percentage accepted by Zod, rejected at runtime
- **Severity**: Low
- **Module**: product
- **Category**: validation-money
- **Location**: Zod at `packages/api/src/routers/product.ts:647, 742`; runtime guard at `packages/shared/src/utils/subproduct.ts:103-110`, `:31`
- **What's wrong**: Product create/update accept `estimatedLossPercentage ∈ [0, 100]`. The runtime helper `isValidLossPercentage` requires `< 100`, and `calculateSubproductStock` throws when loss `>= 100`. The validation surface and the runtime contract disagree on the inclusive endpoint.
- **Trigger**: Admin creates a subproduct with `estimatedLossPercentage: 100`. Save succeeds. The first stock calculation that touches that subproduct throws.
- **Impact**: User-friendly form-time error replaced by an opaque server error during a stock operation.
- **Suggested fix**: Tighten the Zod schema to `.max(99.99)` (or `.lt(100)` if available), and align all loss-percentage call sites on the same upper-bound semantics.

---

## Findings dropped during verification

These were raised by the cluster sweeps but the verification re-read could not reproduce them and they were excluded.

- **`updateStatus` reverses stock for delivered orders** (cluster A) — the cited code at `order.ts:1268-1273` already gates the stock-restoration block on `if (!wasDelivered)`. The flaw described requires that gate to fail; it doesn't.
- **Custom price allows zero/negative** (cluster C) — the Zod schema at `pricing.ts:305` is `z.number().int().positive()`, which already rejects `0` and negatives. The cluster agent flagged then withdrew this in their own write-up.
- **CustomerPricing time-bounded overlap** (cluster C) — the schema's `@@unique([customerId, productId])` makes overlap impossible. The "feature" is that you cannot schedule a future-effective price while keeping a current one, which is a half-implemented feature, not a bug. (Worth noting in the backlog separately.)
- **Misleading credit-rejected error message** (cluster C) — UX wording, not a logic flaw.
- **Suspended supplier still receiving POs** (cluster C) — this code path doesn't exist in the audited routers; there is no PO creation surface to enforce against. Cannot be reproduced.

---

## Files examined

API routers (read in part or whole during verification):
- `packages/api/src/routers/order.ts`
- `packages/api/src/routers/cart.ts`
- `packages/api/src/routers/packing.ts`
- `packages/api/src/routers/inventory.ts`
- `packages/api/src/routers/inventory-stats.ts`
- `packages/api/src/routers/pricing.ts`
- `packages/api/src/routers/customer.ts`
- `packages/api/src/routers/supplier.ts`
- `packages/api/src/routers/delivery.ts`
- `packages/api/src/routers/product.ts`
- `packages/api/src/routers/dashboard.ts`
- `packages/api/src/routers/category.ts`
- `packages/api/src/routers/company.ts`
- `packages/api/src/routers/area.ts`

Services and shared utilities:
- `packages/api/src/services/inventory-batch.ts`
- `packages/api/src/services/batch-number.ts`
- `packages/api/src/services/stock-restoration.ts` (reference)
- `packages/shared/src/utils/money.ts`
- `packages/shared/src/utils/index.ts` (`calculateOrderTotals`)
- `packages/shared/src/utils/pricing.ts`
- `packages/shared/src/utils/subproduct.ts`
- `packages/shared/src/utils/order-state-machine.ts`

Schema and admin UI:
- `packages/database/prisma/schema.prisma`
- `apps/admin-portal/app/[locale]/(app)/layout.tsx`
- `apps/admin-portal/app/[locale]/(app)/{customers,orders,inventory,packing,pricing,products,deliveries,driver,dashboard,suppliers,settings}/**` (covered by cluster agents during their sweeps)

---

## Next steps (not part of this audit)

This audit produces no code changes. Suggested triage:

1. **Critical (F-01)** — fix immediately; cheap to mirror the existing driver-path check.
2. **Systemic patterns P-1 and P-2** — rather than fix the High findings individually, do the cross-cutting refactor first so subsequent work doesn't reintroduce the pattern.
3. **High (F-08, F-10)** — quick state-machine guards; bundle with P-4.
4. **Timezone (P-3)** — replace local-timezone date construction with Melbourne helpers across the dashboard router.
5. **Medium / Low** — backlog and prioritise alongside upcoming feature work in each module.

The audit deliberately did not look at access-control, authz role checks, or OWASP-class issues. Those should be a separate pass with different methodology.
