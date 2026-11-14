# Parking Reservation Bot

A Telegram bot that watches sold-out Inflow parking dates at Alta, Brighton and Solitude and books them on each user's own Inflow account.

## Bookings

**Watch**:
A user's standing request to book one lot on one date, which the bot keeps trying until it books or expires.
_Avoid_: Request, job, snipe

**Reservation**:
A booked parking spot on the user's Inflow account for one lot and date.
_Avoid_: Booking (except for the bot's own record of one), ticket

## Plates

**Saved plate**:
A license plate stored on the user's Inflow account; Inflow is the only place the list of them lives.
_Avoid_: Vehicle, car, bot plate

**Default plate**:
The plate the bot books with when a watch has no plate of its own; a bot setting, not an Inflow concept.
_Avoid_: Primary plate, main plate

**Watch plate**:
A plate set on one watch that replaces the default plate for that watch only.
_Avoid_: Plate override (in conversation), custom plate

**Reservation plate**:
The plate on a reservation, which Inflow lets the user change until the reservation's plate-change deadline.
_Avoid_: Booking plate
