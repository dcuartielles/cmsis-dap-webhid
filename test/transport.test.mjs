/*
 * cmsis-dap-webhid — use CMSIS-DAP probes from the browser over WebHID
 * Copyright (C) 2026 David J. Cuartielles Ruiz
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Tests for the WebHID transport, against a fake HIDDevice.
 *
 * The case that matters is staying in step. CMSIS-DAP is one reply per
 * command, so a single reply left over from an abandoned exchange makes every
 * later command read the previous one's answer — which shows up far away, as
 * "bad response" errors that a reconnect appears to fix by magic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebHIDTransport } from '../src/transport.js';

/** Enough of a HIDDevice to drive the transport. */
function fakeDevice() {
    const listeners = [];
    return {
        opened: false,
        sent: [],
        productName: 'Fake CMSIS-DAP',
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        addEventListener(type, fn) { if (type === 'inputreport') listeners.push(fn); },
        removeEventListener(type, fn) {
            const i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
        },
        async sendReport(id, data) { this.sent.push({ id, data }); },
        /** Pretend the probe answered. */
        deliver(bytes) {
            const data = new DataView(new Uint8Array(bytes).buffer);
            for (const fn of [...listeners]) fn({ data });
        },
    };
}

test('a reply is padded and sent as report 0', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    await transport.write(new Uint8Array([0x00, 0xf0]));

    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].id, 0, 'CMSIS-DAP over HID uses report ID 0');
    assert.equal(device.sent[0].data.length, 64,
        'short buffers must be padded or the probe ignores them');
    assert.equal(device.sent[0].data[1], 0xf0);
});

test('a reply that arrives before it is asked for is not lost', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    await transport.write(new Uint8Array([0x00]));
    device.deliver([0x00, 0x01, 0x02]);        // answered faster than we asked

    const view = await transport.read();
    assert.equal(view.getUint8(1), 0x01);
});

test('a reply that arrives after the request resolves it', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    const pending = transport.read();
    device.deliver([0x00, 0x42]);
    assert.equal((await pending).getUint8(1), 0x42);
});

test('a leftover reply is dropped rather than answering the next command', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    // An exchange nobody collected: the probe answered, the caller gave up.
    await transport.write(new Uint8Array([0x00]));
    device.deliver([0x00, 0xaa]);

    // The next command must not be handed that stale answer.
    await transport.write(new Uint8Array([0x01]));
    assert.equal(transport.staleReports, 1, 'the orphan must be counted');

    const pending = transport.read();
    device.deliver([0x01, 0xbb]);
    assert.equal((await pending).getUint8(1), 0xbb,
        'the reply read must be the one for the command just sent');
});

test('opening starts from a clean queue', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    // A probe left mid-exchange delivers its old reply as soon as we listen.
    device.deliver([0x00, 0x99]);
    await transport.close();
    await transport.open();

    // Nothing should be waiting from before.
    const pending = transport.read();
    device.deliver([0x00, 0x11]);
    assert.equal((await pending).getUint8(1), 0x11);
});

test('a probe that never answers times out instead of hanging', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device, { timeout: 30 });
    await transport.open();

    await assert.rejects(() => transport.read(), /did not answer within 30 ms/);
});

test('closing rejects anything still waiting', async () => {
    const device = fakeDevice();
    const transport = new WebHIDTransport(device);
    await transport.open();

    const pending = transport.read();
    await transport.close();
    await assert.rejects(() => pending, /transport closed/);
});

test('a HIDDevice is required', () => {
    assert.throws(() => new WebHIDTransport(null), /HIDDevice is required/);
});
