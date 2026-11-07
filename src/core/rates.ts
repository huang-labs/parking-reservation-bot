import type { RateMini } from "../inflow/client";

export const isCarpoolRate = (r: Pick<RateMini, "rateName">) => /carpool|4\s*\+/i.test(r.rateName ?? "");

const price = (r: RateMini) => Number(r.finalPrice ?? r.discountedAmountDue ?? r.originalPrice ?? Infinity);

/**
 * Pick the cheapest Available rate the user qualifies for.
 * Carpoolers prefer carpool rates and fall back to regular ones; others never get carpool rates.
 */
export function chooseRate(rates: RateMini[], opts: { carpool: boolean }): RateMini | null {
  const open = rates.filter((r) => r.rateStatus === "Available");
  const byPrice = (a: RateMini, b: RateMini) => price(a) - price(b);
  const carpool = open.filter(isCarpoolRate).sort(byPrice);
  const regular = open.filter((r) => !isCarpoolRate(r)).sort(byPrice);
  if (opts.carpool && carpool.length) return carpool[0]!;
  return regular[0] ?? null;
}
