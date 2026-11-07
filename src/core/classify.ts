import { InflowError } from "../inflow/client";
import { CognitoError } from "../inflow/cognito";

export type FailureClass = "transient" | "user" | "auth";

const USER_REASONS = [
  "MaxConcurrentReservationsReached",
  "MaxTotalReservationsReachedForDay",
  "MaxTotalReservationsReachedForMonth",
  "MaxTotalReservationsReachedUntilDateWithReset",
  "InvalidPlate",
  "MissingPlate",
  "PurchaseInProgress",
  "NoSavedPlate",
];

export const USER_REASON_TEXT: Record<string, string> = {
  MaxConcurrentReservationsReached: "your account is at the max number of active reservations for this lot",
  MaxTotalReservationsReachedForDay: "the per-day reservation limit is reached",
  MaxTotalReservationsReachedForMonth: "the per-month reservation limit is reached",
  MaxTotalReservationsReachedUntilDateWithReset: "the reservation limit is reached",
  InvalidPlate: "Inflow rejected the plate",
  MissingPlate: "no license plate is set",
  PurchaseInProgress: "another checkout is in progress on your account (Inflow allows one at a time)",
  NoSavedPlate: "no default plate is set — pick one in /settings",
};

export function classify(e: unknown): { cls: FailureClass; reason: string } {
  if (e instanceof CognitoError) return { cls: "auth", reason: e.type };
  if (e instanceof InflowError) {
    const reason = e.failReason ?? `HTTP${e.status}`;
    if (reason === "CognitoTokenExpired" || e.status === 401 || e.status === 403) return { cls: "auth", reason };
    if (USER_REASONS.includes(reason)) return { cls: "user", reason };
    return { cls: "transient", reason };
  }
  return { cls: "transient", reason: e instanceof Error ? e.message.slice(0, 120) : String(e) };
}
