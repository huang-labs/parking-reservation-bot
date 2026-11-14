/** License plate rules, matching the Inflow app's own validation. */

/** Uppercase and keep letters and digits only; null unless 2–12 characters remain. */
export function normalizePlate(input: string): string | null {
  const p = input.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return p.length >= 2 && p.length <= 12 ? p : null;
}

/** Inflow treats an empty plate or an `UNKNOWN…` placeholder as "no vehicle yet". */
export const hasPlate = (plate: string) => Boolean(plate) && !plate.toUpperCase().startsWith("UNKNOWN");

/**
 * Whether Inflow still lets the plate on an active reservation change: any time while it has no plate,
 * otherwise until `allowPlateChangeUntil`.
 */
export function canChangePlate(r: { plate: string; allowPlateChangeUntil: string | null }, now = Date.now()): boolean {
  if (!hasPlate(r.plate)) return true;
  return Boolean(r.allowPlateChangeUntil) && Date.parse(r.allowPlateChangeUntil!) > now;
}

/** Plain-English text for a `/plate-update` fail reason. */
export function plateUpdateError(failReason: string | undefined, plate: string): string {
  switch (failReason) {
    case "WindowClosed":
      return "Plate changes for this reservation have closed.";
    case "ReservationExistsForPlate":
      return `${plate} already has a reservation that day.`;
    case "ReservationNotActive":
      return "That reservation is no longer active.";
    case "InvalidPlate":
      return "Inflow rejected that plate.";
    default:
      return `Inflow couldn't change the plate (${failReason ?? "no response"}). Try again in a moment.`;
  }
}
