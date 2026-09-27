# Changelog

## 0.2.0

First published release. Everything here has been exercised against an Arduino
Uno R4 WiFi (Renesas RA4M1, Cortex-M4) with its on-board CMSIS-DAP probe.

### Added

- **WebHID transport for dapjs** (`transport.js`). CMSIS-DAP v1 probes are HID
  devices, which dapjs has no transport for, so until now they could not be
  reached from a browser at all.
- **Cortex-M debug helpers** (`debug.js`): `step`, `trace`, `state`,
  `registers`, `identify`, `probeMemory`, `clearError`, `readSafe`,
  `resetAndRun`.
- **Flash programming** (`flash.js`, `flm.js`). Parses a vendor `.FLM` and runs
  it on the target, which is how OpenOCD and pyOCD write flash. No algorithm is
  bundled: vendor licences generally do not allow redistributing them.
- **Vendor packs** (`pack.js`). Fetches the right algorithm for a named chip
  straight from the vendor's CMSIS pack, over HTTP range requests, without
  downloading the pack: 23 KB out of an 88 MB archive. Nothing touches disk.
  The pack descriptor also supplies the chip's RAM layout.
- **Intel HEX** (`hex.js`). A `.hex` carries the addresses it belongs at; a
  `.bin` does not.
- Two example pages, a debugger and a flasher, and two command-line tools.

### Notes for anyone doing this themselves

Four things cost real time, and none of them show up without hardware:

- **Interrupts take the core away from a flash algorithm.** The board is
  running its own program with its vector table in flash, so the moment the
  core resumes, an interrupt fires and never returns to the breakpoint. Masked
  now, and unmasked afterwards so the new firmware is not left deaf.
- **CMSIS-DAP desynchronises easily.** One reply per command, so a single
  uncollected answer makes every later command read the previous one's. Stale
  replies are dropped before each write.
- **Addresses matter more than they look.** Arduino Uno R4 sketches link at
  `0x4000`, above a bootloader at `0x0`. Writing one to `0x0` erases the
  bootloader and the sketch does not run — and it writes and verifies perfectly
  while doing so.
- **Resetting does not start a board.** `SYSRESETREQ` restarts the system but
  the debug domain survives it, so a halted core stays halted.
