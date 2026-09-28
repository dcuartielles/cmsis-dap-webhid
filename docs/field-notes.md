# Field notes

Things that go wrong when you drive a CMSIS-DAP probe from a browser, with the
error you actually see. None of this was written down anywhere; all of it was
found with a board on the desk.

Headings are the symptom, so searching for the error text should land you in
the right place.

---

## `navigator.hid is undefined` — no buttons, no error

WebHID only exists in a **secure context**. Over plain `http://` the browser
does not expose it at all, so feature detection fails and your page silently
offers nothing.

`localhost` counts as secure. An IP on your LAN does not, which catches people
out: serving from `http://192.0.2.50:8080` will never work, however local it
feels.

```js
if (!('hid' in navigator)) { /* say why, don't just hide the button */ }
```

Firefox and Safari do not implement WebHID and have said they do not intend to,
so this is Chrome and Edge only.

**Fix:** serve over HTTPS. Tailscale gives you a real certificate without
exposing anything; a reverse proxy with TLS works too.

---

## The probe does not appear in the chooser

`navigator.hid.requestDevice({ filters })` only shows devices matching your
filters. Filter too narrowly and your probe is invisible; the user sees an
empty dialog and assumes the board is broken.

Vendor IDs worth allowing: `0x2341` (Arduino), `0x0d28` (NXP/mbed DAPLink),
`0x1366` (SEGGER), `0x03eb` (Atmel/Microchip), `0x2e8a` (Raspberry Pi),
`0x1209` (pid.codes, used by community probes).

Offer an escape hatch that calls `requestDevice({ filters: [] })` so a user
with an unlisted probe can still get through.

**Also:** a board in bootloader mode is a **different USB device** with a
different product ID, and needs its own permission.

---

## `requestDevice` throws "Must be handling a user gesture"

It has to be called from a click or keypress handler. Not from `setTimeout`,
not from a `fetch` callback, not on page load.

Once granted, `navigator.hid.getDevices()` returns the device with no gesture
and no prompt, so only the first time costs a dialog. Use it to reattach
silently on later visits.

---

## `Bad response for 8 -> 17`, and reconnecting "fixes" it

CMSIS-DAP is strictly **one reply per command**. If an exchange is abandoned
half way — a timeout, a reload, a thrown error — the probe still has a reply
queued. It arrives the moment anything starts listening, gets read as the
answer to the *next* command, and from then on every command reads the previous
command's reply.

The numbers in the error are the command you sent and the reply you got, which
is a useful tell: they will be consistently one step apart.

**Fix:** drop anything already queued before writing a command. If something is
waiting there, it belongs to an exchange that is over.

```js
if (this._received.length) this._received = [];
await this.device.sendReport(0, report);
```

## The same error, but after a failed flash

Different cause, same symptom: **nobody closed the transport**. The `HIDDevice`
stays open, and the next attempt builds a *second* transport on top of it. Both
have an `inputreport` listener, replies get split between them, and everything
arrives out of step.

**Fix:** close the transport when you are done — in a `finally`, so it happens
on the error path too — and if you reattach to a device that is already open,
close it before opening it again.

---

## The flash algorithm never returns

You copy the vendor's `Init` into RAM, point the program counter at it, resume,
and the core never comes back to your breakpoint. The operation times out and
the flash is untouched.

**The target is running its own program.** Its vector table is in flash and its
timers are live, so the instant you resume, an interrupt fires and the core
vanishes into the application's handler.

You can see it: halt after the timeout and read the PC. On an Arduino Uno R4 it
landed at `0x0000e4e6`, deep inside the sketch — nowhere near the algorithm in
RAM at `0x20000000`.

**Fix:** mask interrupts before every call. Belt and braces:

```js
await target.writeCoreRegister(20, 1);          // PRIMASK
// C_MASKINTS is only accepted while C_HALT is set
await target.writeMem32(DHCSR, KEY | C_DEBUGEN | C_HALT | C_MASKINTS);
await target.writeMem32(DHCSR, KEY | C_DEBUGEN | C_MASKINTS);   // release
```

Note the resume is a direct `DHCSR` write. dapjs's `resume()` clears the mask,
which undoes the thing you just did.

**Unmask afterwards.** A chip left with its interrupts dead runs the new
firmware badly and looks like a broken build, not a flashing problem.

---

## Reading R0 after a timeout tells you nothing

Related trap, and the reason the above took so long to find. A flash routine
returns its status in `R0`, but only if it *returned*. After a timeout `R0`
holds whatever was there, and `0` means success.

Check where the core actually stopped before believing the result:

```js
const pc = await target.readCoreRegister(15);
if ((pc & ~1) !== returnAddress) throw new Error('it did not return');
```

Landing outside the algorithm's address range almost always means an interrupt
took the core. Say that, rather than "faulted".

---

## `Init failed with code 0x1`

Vendor algorithms inspect the part before touching anything and refuse if its
state makes flash unwritable. They report every reason as the same bare `1`.

Common causes: a clock source or speed outside the writable range, a low-power
mode, a part locked or read-protected.

On a Renesas RA4M1 the check reads `OFS1` at `0x404` for the internal
oscillator frequency and accepts exactly four encodings. The vendor's own
source (shipped in the CMSIS pack) makes this readable — **get it**, it is
worth more than any amount of guessing.

**Try resetting the target first.** A chip that has been halted mid-operation,
or that has had a debug session go wrong, often just needs a clean start.

**A warning about reading registers from a chip in a bad state.** During one
diagnosis `OFS1` read as `0x4c06b538`; after a power cycle the same address
read `0xffffcedf`. The first value was garbage from a confused link, and a
whole theory got built on it. **A value read from a chip that has just
misbehaved is a hypothesis, not a fact.** Reset and read again before
theorising.

---

## It writes, it verifies, and the board does not run

The most convincing failure of them all, because nothing reports an error.

A `.bin` does not say where it goes; you do. Get that wrong and you write a
perfectly good image to the wrong address. Verification compares what you wrote
against the file, so it passes.

Arduino Uno R4 sketches link at **`0x4000`**, above a bootloader at `0x0`.
Writing one to `0x0`:

- erases the bootloader — the board stops answering USB, double-tap reset dies;
- leaves the sketch 16 KB below where its own absolute addresses point, so it
  does not run either.

**Fix:** use a `.hex`. Intel HEX carries the addresses for each chunk, so the
file decides and you cannot get it wrong. If you must take a raw binary, demand
an explicit address rather than defaulting to the start of flash.

**If you did erase the bootloader**, you can put it back over CMSIS-DAP — it
does not depend on the bootloader existing. Arduino ships the images inside the
board package (`bootloaders/UNO_R4/dfu_wifi.hex`). That is worth knowing before
you panic.

---

## Reset works, but the board sits there

`SYSRESETREQ` restarts the system. **The debug domain survives it.** A core
halted for flashing — which it always is by then — comes out of reset still
halted and still held by the debugger.

**Fix:** hand the core back after resetting.

```js
await target.writeMem32(DEMCR, 0);                  // no vector catch
await target.writeMem32(AIRCR, VECTKEY | SYSRESETREQ);
await sleep(100);
await target.writeMem32(DHCSR, DBGKEY);             // no C_DEBUGEN, no C_HALT
```

The `AIRCR` write often fails because the reset cuts the transfer short. That
means it worked. Catch it and carry on, then retry the `DHCSR` write while the
chip comes back up.

---

## One bad read and then everything fails

Reading an unmapped address returns a `FAULT` **and leaves the DAP stuck**:
every later access fails until the sticky error is cleared through the ABORT
register. Without clearing it, a single bad read means reloading the page.

```js
await target.writeDP(0x0, 0x1e);   // STKCMPCLR | STKERRCLR | WDERRCLR | ORUNERRCLR
```

Wrap reads that might miss, and clear on the way out.

---

## Addresses from generic OpenOCD configs are not always real

On the RA4M1, `0x1ffe0000` is listed as the work area and faults on access;
usable RAM starts at `0x20000000`. The stack pointer in the vector table gave
it away.

Probe rather than assume: read a few candidate addresses, recover from the
faults, and see what answers.

---

## The browser cannot download vendor packs (CORS)

Flash algorithms live in CMSIS packs. `keil.com`, its Azure mirror,
`packs.download.arm.com` and vendor mirrors **all fail CORS**, measured from a
GitHub Pages origin. A page cannot fetch them, full stop.

**What works:** have your server fetch the pack and serve the `.FLM` from your
own origin. Or let the user download the pack normally — that is navigation,
not a fetch — and hand the file to the page.

A `.pack` is a zip, so you can read one without downloading it: fetch the tail
to find the central directory, then fetch only the entry you want. That turns
an 88 MB download into 23 KB.

---

## You probably cannot redistribute the `.FLM`

Vendor algorithms carry vendor licences. The Renesas RA4M1 one is Apache-2.0
from ARM **plus** a Renesas notice limiting use to Renesas parts — a
field-of-use restriction no free licence can pass on.

Changing your own licence does not help: the permission you need is the
vendor's to give, not yours. Fetch at runtime instead, as pyOCD does. (pyOCD
does bundle 136 algorithms, but their copyright is ARM's, from the FlashAlgo
project — not the chip vendors'.)

---

## The permission keeps getting asked for

WebHID permissions are **per origin and per device**, and:

- they survive closing the tab and restarting the browser;
- they **do not** survive incognito — lost when the window closes;
- they are **not shared between browser profiles**.

Those last two explain almost every "it keeps asking me".

---

## WebHID inside a VS Code webview

It does not work, and it is not a bug you can route around. The default
allowlist for the `hid` permission is `self`, so an iframe only has it if the
container delegates it — and VS Code delegates only `clipboard-read` and
`clipboard-write`. `navigator.hid` is `undefined` in there.

A **Chrome extension** can use WebHID (Chrome 117+), with one rule:
`requestDevice()` cannot be called from a service worker. Call it from a popup
or options page on a user gesture, then message the worker, which can use
`getDevices()`. An open device connection keeps the service worker alive.

---

## If you are writing this yourself

The wire protocol is simpler than it looks: 64-byte reports both ways, report
ID 0, one reply per command. The subtle part is that WebHID delivers reports
through events while dapjs wants to pull them with `read()`, so you need a
queue between the two — and a timeout, or a command the probe does not
understand looks like a hang.

Everything above is implemented in
[cmsis-dap-webhid](https://github.com/dcuartielles/cmsis-dap-webhid). Reports
of other probes and other chips are welcome: all of this was learned on one
board, and the next one will teach us something else.
