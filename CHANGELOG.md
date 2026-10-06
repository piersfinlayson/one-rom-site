# Changelog

## 2026-10-06

- WASM v0.6.0, for firmware v0.8.0
- Web supports commissioning information and L sized boards
- A connected One ROM Lab is identified
- A One ROM Lab image fails to program
- One ROM Builder supports reading and writing reserved pins

## 2026-10-01

- WASM v0.5.3
- Swap bytes for 16-bit ROM types in the One ROM Builder and Custom ROM Image
  tabs. It is ticked automatically for an image recognised as stored high byte
  first. Amiga Kickstart images usually are.

## 2026-09-17

- WASM v0.5.2, adding the `27C400Pin31A17` and `27C200Pin31NC` chip types for
  the Amiga A500 rev 5 Kickstart socket, and `HN613128P` as an alias for `23128`

## 2026-09-16

- Stop, Run and Program no longer reconnect to a device Chrome lists but can
  no longer open, which failed with "Access denied" on Linux

## 2026-08-09

- WASM v0.5.0
- New One ROM Builder tab
