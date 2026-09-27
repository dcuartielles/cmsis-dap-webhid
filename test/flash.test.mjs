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
 * Checks the arithmetic that cannot be checked against hardware cheaply:
 * where things land in RAM, which sectors a range touches, and that a call
 * sets up the registers the way a Cortex-M expects.
 *
 *   node --test test/
 *
 * The flash itself still has to be proven on a real chip. This only makes sure
 * we do not waste those attempts on off-by-one errors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlashProgrammer, OPERATION } from '../src/flash.js';
import { CORE_REG, DHCSR, REG } from '../src/debug.js';

/** An algorithm shaped like the RA4M1 one, without the vendor's code. */
function fakeAlgorithm() {
    return {
        device: {
            name: 'Test 256KB Flash',
            address: 0x00000000,
            size: 256 * 1024,
            pageSize: 2048,
            valueEmpty: 0xff,
            programTimeout: 1000,
            eraseTimeout: 3000,
            sectors: [{ size: 2048, address: 0 }],
        },
        code: new Uint8Array(3800).fill(0xa5),
        codeAddress: 0,
        dataOffset: 3796,
        zeroInitSize: 52,
        symbols: {},
        entries: {
            Init: 0x28c, UnInit: 0x888, EraseChip: 0x14c,
            EraseSector: 0x1e8, ProgramPage: 0x6d4,
        },
    };
}

/**
 * A target that records what was done to it. The core "returns" immediately:
 * DHCSR reads back as halted and the PC as the return address.
 */
function fakeTarget() {
    const memory = new Map();
    const calls = [];
    let registers = {};

    return {
        calls,
        memory,
        lastRegisters: () => registers,

        async halt() { calls.push(['halt']); },
        async resume() { calls.push(['resume', { ...registers }]); },
        async isHalted() { return true; },

        async writeCoreRegister(number, value) { registers[number] = value >>> 0; },
        async readCoreRegister(number) {
            if (number === CORE_REG.PC) return registers.returnTo ?? 0;
            if (number === CORE_REG.R0) return 0;          // success
            return registers[number] ?? 0;
        },

        async readMem32(address) {
            if (address === REG.DHCSR) return DHCSR.S_HALT | DHCSR.C_DEBUGEN;
            return memory.get(address) ?? 0;
        },
        async writeMem32(address, value) {
            memory.set(address, value >>> 0);
            calls.push(['writeMem32', address, value >>> 0]);
        },
        async writeBlock(address, words) {
            calls.push(['writeBlock', address, words.length]);
            for (let i = 0; i < words.length; i++) {
                memory.set(address + i * 4, words[i] >>> 0);
            }
        },
        async readBlock(address, count) {
            const out = new Uint32Array(count);
            for (let i = 0; i < count; i++) out[i] = memory.get(address + i * 4) ?? 0;
            return out;
        },
    };
}

function programmer(options = {}) {
    const algorithm = fakeAlgorithm();
    const target = fakeTarget();
    const flash = new FlashProgrammer(target, algorithm, {
        ramAddress: 0x20000000, ramSize: 0x8000, ...options,
    });
    // Let the fake core "return" where the programmer expects it to.
    target.lastRegisters().returnTo = flash.returnAddress;
    return { flash, target, algorithm };
}

test('the RAM layout leaves no region overlapping another', () => {
    const { flash, algorithm } = programmer();

    const codeEnd = flash.codeBase + algorithm.code.length + algorithm.zeroInitSize;
    assert.ok(flash.returnAddress >= codeEnd,
        'the breakpoint word must sit past the code and its zero-init data');
    assert.ok(flash.stackTop > flash.returnAddress + 4,
        'the stack must start past the breakpoint word');
    assert.equal(flash.bufferAddress, flash.stackTop,
        'the page buffer starts where the stack tops out');
    assert.equal(flash.stackTop % 8, 0, 'AAPCS wants the stack 8-byte aligned');
    assert.equal(flash.staticBase, flash.codeBase + algorithm.dataOffset);
});

test('it refuses to run when the chip has too little RAM', () => {
    assert.throws(
        () => programmer({ ramSize: 0x1000 }),
        /needs \d+ bytes of RAM/);
});

test('a call sets up the registers a Cortex-M needs', async () => {
    const { flash, target } = programmer();
    await flash.call('EraseSector', [0x800]);

    const resumed = target.calls.find(c => c[0] === 'resume');
    assert.ok(resumed, 'the core must actually be resumed');
    const registers = resumed[1];

    assert.equal(registers[CORE_REG.R0], 0x800, 'the argument goes in R0');
    assert.equal(registers[CORE_REG.R9], flash.staticBase,
        'R9 must point at the algorithm data');
    assert.equal(registers[CORE_REG.SP], flash.stackTop);
    assert.equal(registers[CORE_REG.LR], (flash.returnAddress | 1) >>> 0,
        'the link register needs the Thumb bit or the return faults');
    assert.equal(registers[CORE_REG.PC], (flash.codeBase + 0x1e8 | 1) >>> 0);
    assert.equal(registers[CORE_REG.xPSR], 0x01000000,
        'xPSR must have T set');
});

test('a breakpoint is planted at the return address', async () => {
    const { flash, target } = programmer();
    await flash.load();
    assert.equal(target.memory.get(flash.returnAddress), 0xbe00be00);
});

test('halting anywhere but the return address is reported as a fault', async () => {
    const { flash, target } = programmer();
    target.lastRegisters().returnTo = 0x20000100;   // not where we sent it
    await assert.rejects(
        () => flash.call('EraseSector', [0]),
        /faulted/);
});

test('a range maps onto the sectors it actually touches', () => {
    const { flash } = programmer();

    assert.deepEqual(
        flash.sectorsFor(0, 1).map(s => s.address),
        [0], 'one byte still means one whole sector');

    assert.deepEqual(
        flash.sectorsFor(0, 2048).map(s => s.address),
        [0], 'an exact sector must not drag in the next one');

    assert.deepEqual(
        flash.sectorsFor(0, 2049).map(s => s.address),
        [0, 2048], 'one byte over spills into the next sector');

    assert.deepEqual(
        flash.sectorsFor(1000, 2000).map(s => s.address),
        [0, 2048], 'an unaligned start erases from the sector it falls in');
});

test('stepped sector sizes map correctly', () => {
    // Real geometry, from the Keil STM32F4xx_1024 algorithm: sectors grow from
    // 16 KB to 64 KB to 128 KB. A descriptor entry applies until the next
    // begins, which is the case uniform flash like the RA4M1 never exercises.
    const algorithm = fakeAlgorithm();
    algorithm.device.address = 0x08000000;
    algorithm.device.size = 1024 * 1024;
    algorithm.device.sectors = [
        { size: 16 * 1024, address: 0x00000 },
        { size: 64 * 1024, address: 0x10000 },
        { size: 128 * 1024, address: 0x20000 },
    ];
    const flash = new FlashProgrammer(fakeTarget(), algorithm, {
        ramAddress: 0x20000000, ramSize: 0x20000,
    });

    assert.deepEqual(
        flash.sectorsFor(0x08000000, 1).map(s => [s.address, s.size]),
        [[0x08000000, 16 * 1024]], 'the first sector is a small one');

    assert.deepEqual(
        flash.sectorsFor(0x08010000, 1).map(s => [s.address, s.size]),
        [[0x08010000, 64 * 1024]], 'the 64 KB band starts exactly here');

    assert.deepEqual(
        flash.sectorsFor(0x08030000, 1).map(s => [s.address, s.size]),
        [[0x08020000, 128 * 1024]],
        'an address inside a 128 KB sector erases from that sector start');

    // A write crossing all three bands must erase whole sectors of each size.
    assert.deepEqual(
        flash.sectorsFor(0x08000000, 0x30000).map(s => s.size / 1024),
        [16, 16, 16, 16, 64, 128]);
});

test('writing past the end of flash is refused', () => {
    const { flash } = programmer();
    assert.throws(
        () => flash.sectorsFor(255 * 1024, 4 * 1024),
        /outside the device/);
});

test('a short last page is padded with the erased value, not with junk', async () => {
    const { flash, target } = programmer();
    await flash.load();
    target.calls.length = 0;

    await flash.programPage(0, new Uint8Array([1, 2, 3]));

    const written = target.calls.find(
        c => c[0] === 'writeBlock' && c[1] === flash.bufferAddress);
    assert.ok(written, 'the page must be staged in the buffer');
    assert.equal(written[2], 2048 / 4, 'a whole page is always written');

    const second = target.memory.get(flash.bufferAddress + 4) >>> 0;
    assert.equal(second, 0xffffffff, 'the tail must read as erased');
});

test('program erases every sector it is about to write', async () => {
    const { flash, target } = programmer();
    const phases = [];
    await flash.program(0, new Uint8Array(4096).fill(0x42), {
        onProgress: p => phases.push(`${p.phase} ${p.done}/${p.total}`),
    });

    assert.deepEqual(phases, [
        'erase 1/2', 'erase 2/2', 'program 1/2', 'program 2/2',
    ]);
});

test('verify compares against the erased value past the end of the image', async () => {
    const { flash, target } = programmer();
    // One word of data, then erased flash.
    target.memory.set(0, 0x04030201);
    target.memory.set(4, 0xffffffff);

    await flash.verify(0, new Uint8Array([1, 2, 3, 4, 0xff]));

    target.memory.set(4, 0x00000000);
    await assert.rejects(() => flash.verify(0, new Uint8Array([1, 2, 3, 4, 0xff])),
        /verify failed at 0x4/);
});

test('OPERATION carries the FlashOS codes', () => {
    assert.deepEqual(OPERATION, { ERASE: 1, PROGRAM: 2, VERIFY: 3 });
});
