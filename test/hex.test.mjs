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
 * Tests for Intel HEX.
 *
 * The point of supporting this format is that the file says where it goes. A
 * raw binary does not, and writing one to the wrong address produces an image
 * that verifies perfectly and then does not run — so the test that matters
 * most is that addresses survive the round trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntelHex, flatten, readFirmware } from '../src/hex.js';

/** Build a valid record, checksum and all. */
function record(type, offset, bytes = []) {
    const all = [bytes.length, (offset >> 8) & 0xff, offset & 0xff, type, ...bytes];
    let sum = 0;
    for (const byte of all) sum += byte;
    all.push((-sum) & 0xff);
    return ':' + all.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

const END = record(0x01, 0);

test('data records become one segment at the right address', () => {
    const hex = [
        record(0x00, 0x0000, [0x01, 0x02, 0x03, 0x04]),
        record(0x00, 0x0004, [0x05, 0x06]),
        END,
    ].join('\n');

    const parsed = parseIntelHex(hex);
    assert.equal(parsed.segments.length, 1, 'touching records must merge');
    assert.equal(parsed.segments[0].address, 0);
    assert.deepEqual(Array.from(parsed.segments[0].data), [1, 2, 3, 4, 5, 6]);
    assert.equal(parsed.start, 0);
    assert.equal(parsed.end, 6);
});

test('a gap stays a gap instead of being padded over', () => {
    const hex = [
        record(0x00, 0x0000, [0xaa]),
        record(0x00, 0x0010, [0xbb]),
        END,
    ].join('\n');

    const parsed = parseIntelHex(hex);
    assert.equal(parsed.segments.length, 2,
        'separate runs must stay separate, or flashing would erase what lies between');
    assert.equal(parsed.segments[1].address, 0x10);
});

test('extended linear addressing reaches past 64 KB', () => {
    const hex = [
        record(0x04, 0, [0x00, 0x01]),        // upper half = 0x0001 -> 0x10000
        record(0x00, 0x4000, [0x42]),
        END,
    ].join('\n');

    const parsed = parseIntelHex(hex);
    assert.equal(parsed.segments[0].address, 0x14000,
        'the extended record must be added to the record offset');
});

test('the entry point is picked up', () => {
    const hex = [
        record(0x00, 0, [0x00]),
        record(0x05, 0, [0x00, 0x00, 0x1f, 0x35]),
        END,
    ].join('\n');
    assert.equal(parseIntelHex(hex).entry, 0x00001f35);
});

test('a corrupt checksum is rejected', () => {
    const good = record(0x00, 0, [0x01, 0x02]);
    const bad = good.slice(0, -2) + '00';
    assert.throws(() => parseIntelHex([bad, END].join('\n')), /checksum/);
});

test('a truncated file is rejected rather than half-flashed', () => {
    const hex = record(0x00, 0, [0x01, 0x02]);      // no end record
    assert.throws(() => parseIntelHex(hex), /no end-of-file record/);
});

test('something that is not Intel HEX is rejected', () => {
    assert.throws(() => parseIntelHex('not a hex file at all'), /not Intel HEX/);
});

test('flatten fills gaps with the erased value', () => {
    const segments = [
        { address: 0x100, data: new Uint8Array([1, 2]) },
        { address: 0x108, data: new Uint8Array([3]) },
    ];
    const image = flatten(segments);
    assert.equal(image.address, 0x100);
    assert.equal(image.data.length, 9);
    assert.deepEqual(Array.from(image.data),
        [1, 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 3]);
});

test('readFirmware takes the address from a .hex and needs one for a .bin', () => {
    const hex = [record(0x00, 0x4000, [0xde, 0xad]), END].join('\n');

    const fromHex = readFirmware(hex);
    assert.equal(fromHex.address, 0x4000, 'the file decides, not the caller');
    assert.equal(fromHex.format, 'ihex');

    // This is the mistake worth preventing: a raw image with no address.
    assert.throws(
        () => readFirmware(new Uint8Array([1, 2, 3]), { name: 'sketch.bin' }),
        /does not say where it goes/);

    const fromBin = readFirmware(new Uint8Array([1, 2, 3]),
        { name: 'sketch.bin', address: 0x4000 });
    assert.equal(fromBin.address, 0x4000);
    assert.equal(fromBin.format, 'bin');
});

test('a .hex given as bytes is still read as text', () => {
    const hex = [record(0x00, 0x20, [0x7f]), END].join('\n');
    const parsed = readFirmware(new TextEncoder().encode(hex), { name: 'boot.hex' });
    assert.equal(parsed.address, 0x20);
    assert.equal(parsed.format, 'ihex');
});
