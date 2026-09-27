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
 * Tests for reading pack descriptors. No network: the XML below is a trimmed
 * copy of the real shape, kept small enough to reason about.
 *
 * The part that needs testing is inheritance. A device inherits the algorithms
 * and memories its family and sub-family declared, and the natural way to get
 * that wrong is to let an inner level's absent attribute erase an outer
 * level's present one — which is exactly the bug these caught.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDescriptor, ramFor, openZip } from '../src/pack.js';

const DESCRIPTOR = `<?xml version="1.0"?>
<package>
 <devices>
  <family Dfamily="RA4M1 Series" Dvendor="Renesas:117">
   <processor Dcore="Cortex-M4" Dendian="Little-endian"/>
   <memory name="Common" access="rw" start="0x30000000" size="0x100"/>
   <subFamily DsubFamily="RA4M1_256K">
    <memory name="Flash" access="rx" start="0x00000000" size="0x040000" default="1"/>
    <memory name="SRAM1" access="rwx" start="0x20000000" size="0x008000" default="1"/>
    <algorithm name="Flash/RA4M1_256K.FLM" start="0x00000000" size="0x040000"
               RAMstart="0x20000000" RAMsize="0x2800" default="1"/>
    <algorithm name="Flash/RA4M1_DATA.FLM" start="0x40100000" size="0x002000"
               RAMstart="0x20000000" RAMsize="0x2800" default="1"/>
    <device Dname="R7FA4M1AB"/>
   </subFamily>
  </family>
  <family Dfamily="RA4M2 Series" Dvendor="Renesas:117">
   <processor Dcore="Cortex-M33"/>
   <subFamily DsubFamily="RA4M2">
    <memory name="SRAM1" access="rwx" start="0x20000000" size="0x020000" default="1"/>
    <algorithm name="Flash/RA4M2.FLM" start="0x00000000" size="0x080000"
               RAMstart="0x20000000" RAMsize="0x4000" default="1"/>
    <device Dname="R7FA4M2AD"/>
   </subFamily>
  </family>
 </devices>
</package>`;

const devices = parseDescriptor(DESCRIPTOR);
const ra4m1 = devices.find(d => d.name === 'R7FA4M1AB');
const ra4m2 = devices.find(d => d.name === 'R7FA4M2AD');

test('every declared device is found', () => {
    assert.equal(devices.length, 2);
    assert.ok(ra4m1 && ra4m2);
});

test('a device inherits what its family declared', () => {
    assert.equal(ra4m1.family, 'RA4M1 Series');
    assert.equal(ra4m1.subFamily, 'RA4M1_256K');
    assert.equal(ra4m1.vendor, 'Renesas:117');
    // From <processor> at family level, which the device never repeats.
    assert.equal(ra4m1.core, 'Cortex-M4');
});

test('a sibling family does not leak into the next', () => {
    assert.equal(ra4m2.core, 'Cortex-M33',
        'the second family must not inherit the first one\'s core');
    assert.equal(ra4m2.family, 'RA4M2 Series');
    assert.equal(ra4m2.algorithms.length, 1,
        'RA4M1 algorithms must not appear under RA4M2');
});

test('memories accumulate down the tree', () => {
    const names = ra4m1.memories.map(m => m.name);
    assert.deepEqual(names, ['Common', 'Flash', 'SRAM1'],
        'the family-level memory is inherited alongside the sub-family ones');
});

test('ramFor picks writable memory, never flash', () => {
    const ram = ramFor(ra4m1);
    assert.equal(ram.name, 'SRAM1');
    assert.equal(ram.start, 0x20000000);
    assert.equal(ram.size, 0x8000);
});

test('hex and decimal attributes both parse', () => {
    const algorithm = ra4m1.algorithms[0];
    assert.equal(algorithm.start, 0x00000000);
    assert.equal(algorithm.size, 0x040000);
    assert.equal(algorithm.ramStart, 0x20000000);
    assert.equal(algorithm.ramSize, 0x2800);
    assert.equal(algorithm.default, true);
});

test('a device declaring several algorithms keeps them in order', () => {
    assert.deepEqual(
        ra4m1.algorithms.map(a => a.name),
        ['Flash/RA4M1_256K.FLM', 'Flash/RA4M1_DATA.FLM'],
        'code flash first, data flash second, as the descriptor lists them');
});

/** Build a minimal zip in memory, stored (uncompressed), for the reader. */
function buildZip(files) {
    const encoder = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;

    for (const [name, text] of Object.entries(files)) {
        const nameBytes = encoder.encode(name);
        const data = encoder.encode(text);
        const crc = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length + data.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(8, 0, true);                    // stored
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(10, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);

        locals.push(local);
        centrals.push(central);
        offset += local.length;
    }

    const directorySize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, centrals.length, true);
    ev.setUint16(10, centrals.length, true);
    ev.setUint32(12, directorySize, true);
    ev.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, eocd];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const zip = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { zip.set(part, at); at += part.length; }
    return zip;
}

let table = null;
function crc32(bytes) {
    if (!table) {
        table = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[i] = c;
        }
    }
    let crc = -1;
    for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
}

test('the zip reader finds entries and checks their CRC', async () => {
    const zip = buildZip({ 'Flash/One.FLM': 'first', 'Vendor.Pack.pdsc': '<xml/>' });
    // Read it the way the network path does: a byte range at a time.
    const archive = await openZip({
        size: zip.length,
        read: async (start, end) => zip.slice(start, end + 1),
    });

    assert.deepEqual(archive.entries.map(e => e.name),
        ['Flash/One.FLM', 'Vendor.Pack.pdsc']);

    const data = await archive.read('Flash/One.FLM');
    assert.equal(new TextDecoder().decode(data), 'first');

    // A bare name must resolve against the path it lives at.
    const again = await archive.read('One.FLM');
    assert.equal(new TextDecoder().decode(again), 'first');

    await assert.rejects(() => archive.read('missing.FLM'), /no entry called/);
});

test('a corrupt entry is rejected rather than returned', async () => {
    const zip = buildZip({ 'Flash/One.FLM': 'first' });
    const archive = await openZip({
        size: zip.length,
        read: async (start, end) => {
            const slice = zip.slice(start, end + 1);
            // Corrupt the payload only, leaving the structure intact.
            if (slice.length === 5) slice[0] ^= 0xff;
            return slice;
        },
    });
    await assert.rejects(() => archive.read('Flash/One.FLM'), /checksum/);
});
