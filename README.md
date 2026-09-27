# cmsis-dap-webhid

Use **CMSIS-DAP** debug probes from a web page, over **WebHID**.

[dapjs](https://github.com/ARMmbed/dapjs), ARM's own library, ships transports
for Node and for WebUSB — but **CMSIS-DAP v1 probes enumerate as HID devices**,
so in a browser they cannot be reached at all. This is the missing transport,
plus the Cortex-M debug helpers you need right after it.

```js
import { requestTransport, identify, registers, trace, hex } from 'cmsis-dap-webhid';
import { CortexM } from 'dapjs';

// Must come from a click: WebHID requires a user gesture.
const transport = await requestTransport();
const target = new CortexM(transport);
await target.connect();

console.log(await identify(target));      // { core: 'Cortex-M4', ... }

await target.halt();
console.log(await registers(target));     // { PC: ..., SP: ..., LR: ... }
console.log((await trace(target, 10)).map(v => hex(v)));
await target.resume();
```

## Why this exists

Debugging an ARM microcontroller normally means installing a toolchain. With a
CMSIS-DAP probe and a browser, you can halt a running core, single-step it and
read its memory from a web page — no install, nothing to configure. That is a
useful teaching tool, and a convenient one for quick inspection.

## Install

```bash
npm install cmsis-dap-webhid dapjs
```

Or use it straight from a page, no build step:

```html
<script type="module">
  import { requestTransport } from 'https://esm.sh/cmsis-dap-webhid';
  import { CortexM } from 'https://esm.sh/dapjs';
</script>
```

**Requires Chrome or Edge.** Firefox and Safari do not implement WebHID, and
have said they do not intend to. The page must also be served over HTTPS or
from `localhost`.

## What you get

### Transport

| | |
|---|---|
| `WebHIDTransport(device, options)` | The dapjs transport. Wrap a `HIDDevice` |
| `requestTransport(options)` | Ask the user for a probe, return it open |
| `getTransports(options)` | Transports for already-granted probes |
| `KNOWN_PROBES` | Vendor IDs of common probes, as a device filter |

### Debug helpers

| | |
|---|---|
| `step(target)` | Execute one instruction. **dapjs does not expose this** |
| `trace(target, n)` | Step `n` times, return the PC at each stop |
| `state(target)` | Halted? sleeping? locked up? |
| `registers(target)` | All core registers at once |
| `identify(target)` | Which Cortex-M this is, from CPUID |
| `clearError(target)` | **Recover from a stuck transfer.** See below |
| `readSafe(target, addr)` | Read, returning `null` for unmapped addresses |
| `probeMemory(target, addrs)` | Find where memory actually is |

## Two things worth knowing

**A failed transfer leaves the DAP stuck.** Reading an unmapped address returns
a `FAULT`, and from then on *every* access fails until the error is cleared
through the ABORT register. Without `clearError()`, a single bad read means
reloading the page. `readSafe()` handles it for you.

**Addresses from generic OpenOCD configs are not always right.** On the Renesas
RA4M1, `0x1ffe0000` appears as the work area and faults; usable RAM starts at
`0x20000000`. `probeMemory()` exists to find out rather than assume.

## Getting a permission

WebHID only prompts from a user gesture, so `requestTransport()` has to be
called from a click. Once granted, the permission persists for that origin and
`getTransports()` returns the probe without asking again.

Note that **a board in bootloader mode is a different USB device** and needs its
own permission.

## Tested with

- **Arduino Uno R4 WiFi** (Renesas RA4M1, Cortex-M4) — its on-board CMSIS-DAP
  reports itself as `TinyUSB CMSIS-DAP`, 64-byte reports, report ID 0.

It should work with any CMSIS-DAP v1 probe. Reports of what does and does not
work are welcome.

## Scope

This library covers **talking to the probe and debugging the core**. Writing
flash is not included: that needs a device-specific flash algorithm, which is a
separate problem. `dapjs` offers `DAPLink` for probes that support it.

## Example

`examples/debugger/` is a self-contained page: connect a probe, halt the core,
step through instructions and dump memory. Serve it over HTTPS or `localhost`
and open it in Chrome.

## Licence

MIT. `dapjs` is a peer dependency and is licensed separately by ARM (Apache-2.0).
