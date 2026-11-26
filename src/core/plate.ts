/** Normalize a typed plate the way the Inflow app does: uppercase A–Z0–9 only, 2–18 characters. */
export function normalizePlate(raw: string): string | null {
  const p = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return p.length >= 2 && p.length <= 18 ? p : null;
}

/** Plain-language text for `/plate-update` fail reasons. */
export const PLATE_UPDATE_ERRORS: Record<string, string> = {
  WindowClosed: "Inflow no longer allows plate changes for this reservation.",
  ReservationExistsForPlate: "That plate already has a reservation for this day.",
  InvalidPlate: "Inflow rejected that plate.",
  ReservationNotActive: "This reservation is no longer active.",
};
