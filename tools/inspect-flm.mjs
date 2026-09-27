#!/usr/bin/env node
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
 * Print what is inside a CMSIS flash algorithm.
 *
 *   node tools/inspect-flm.mjs path/to/Device.FLM
 *
 * Useful before trusting an algorithm: it shows the flash geometry the vendor
 * declares and which functions the algorithm actually exports.
 */

import { readFileSync } from 'node:fs';
import { parseFLM } from '../src/flm.js';

const path = process.argv[2];
if (!path) {
    console.error('usage: node tools/inspect-flm.mjs <file.FLM>');
    process.exit(2);
}

const hex = (value, digits = 8) =>
    '0x' + (value >>> 0).toString(16).padStart(digits, '0');

const kb = bytes =>
    bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes % 1024 ? 1 : 0)} KB` : `${bytes} B`;

let flm;
try {
    flm = parseFLM(readFileSync(path));
} catch (error) {
    console.error(`cannot read ${path}: ${error.message}`);
    process.exit(1);
}

const { device } = flm;

console.log(`device        ${device.name}`);
console.log(`type          ${device.type}   (descriptor version ${device.version})`);
console.log(`flash         ${hex(device.address)} .. ${hex(device.address + device.size - 1)}   ${kb(device.size)}`);
console.log(`page          ${kb(device.pageSize)}`);
console.log(`erased byte   ${hex(device.valueEmpty, 2)}`);
console.log(`timeouts      program ${device.programTimeout} ms, erase ${device.eraseTimeout} ms`);

console.log('sectors');
for (const sector of device.sectors) {
    // Addresses in the descriptor are relative to the start of flash.
    const start = device.address + sector.address;
    console.log(`  ${kb(sector.size).padStart(8)} sectors from ${hex(start)}`);
}

console.log();
console.log(`code          ${flm.code.length} bytes, linked at ${hex(flm.codeAddress)}`);
console.log(`zero-init     ${flm.zeroInitSize} bytes`);
console.log('entry points');
for (const [name, offset] of Object.entries(flm.entries)) {
    console.log(`  ${name.padEnd(12)} +${hex(offset, 4)}`);
}

const missing = ['EraseSector', 'EraseChip', 'Verify', 'BlankCheck']
    .filter(name => !(name in flm.entries));
if (missing.length) {
    console.log();
    console.log(`not provided: ${missing.join(', ')}`);
}
