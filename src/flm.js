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
 * Parser for CMSIS flash algorithms (`.FLM` files).
 *
 * A `.FLM` is an ARM ELF object holding a handful of position-independent
 * functions — Init, EraseSector, ProgramPage — plus a `FlashDevice` descriptor
 * saying where the flash lives and how it is divided into sectors. Silicon
 * vendors ship one for each part, inside a CMSIS pack.
 *
 * Debuggers do not reimplement flash drivers: they copy these functions into
 * the target's RAM and call them there. That is what `flash.js` does with the
 * output of this parser.
 *
 * **No algorithm is bundled with this library.** Vendor packs carry their own
 * licences, often restricting use to that vendor's own chips, which cannot be
 * redistributed under the GPL. Download the pack for your part and supply the
 * `.FLM` yourself; the README explains how.
 *
 * Works in the browser and in Node: it only needs an ArrayBuffer.
 */

const ELF_MAGIC = 0x464c457f;   // "\x7fELF" read as a little-endian uint32
const EM_ARM = 0x28;

const SHT_PROGBITS = 1;
const SHT_SYMTAB   = 2;
const SHT_NOBITS   = 8;
const SHF_ALLOC    = 0x2;

/** The descriptor section, as named by the CMSIS template. */
const DEVICE_SECTION = 'DevDscr';

/** Functions an algorithm may export. Init and ProgramPage are mandatory. */
export const ALGO_FUNCTIONS = [
    'Init', 'UnInit', 'EraseChip', 'EraseSector', 'ProgramPage',
    'Verify', 'BlankCheck',
];

/** FlashDevice.DevType, from FlashOS.h. */
const DEVICE_TYPES = {
    0: 'unknown', 1: 'onchip', 2: 'ext8bit', 3: 'ext16bit',
    4: 'ext32bit', 5: 'extspi',
};

function readString(bytes, offset) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(offset, end));
}

/** Read the ELF section table. */
function readSections(view, bytes) {
    const shoff     = view.getUint32(0x20, true);
    const shentsize = view.getUint16(0x2e, true);
    const shnum     = view.getUint16(0x30, true);
    const shstrndx  = view.getUint16(0x32, true);

    // Section names live in a section of their own, so locate that one first.
    const namesOffset = view.getUint32(shoff + shstrndx * shentsize + 0x10, true);

    const sections = [];
    for (let i = 0; i < shnum; i++) {
        const base = shoff + i * shentsize;
        sections.push({
            name:    readString(bytes, namesOffset + view.getUint32(base + 0x00, true)),
            type:    view.getUint32(base + 0x04, true),
            flags:   view.getUint32(base + 0x08, true),
            addr:    view.getUint32(base + 0x0c, true),
            offset:  view.getUint32(base + 0x10, true),
            size:    view.getUint32(base + 0x14, true),
            link:    view.getUint32(base + 0x18, true),
            entsize: view.getUint32(base + 0x24, true),
        });
    }
    return sections;
}

/** Symbol name to address, for every named symbol in the table. */
function readSymbols(view, bytes, sections) {
    const symtab = sections.find(s => s.type === SHT_SYMTAB);
    if (!symtab) return {};
    const strtab = sections[symtab.link];

    const symbols = {};
    const stride = symtab.entsize || 16;
    for (let i = 0; i < symtab.size / stride; i++) {
        const base = symtab.offset + i * stride;
        const name = readString(bytes, strtab.offset + view.getUint32(base, true));
        if (name) symbols[name] = view.getUint32(base + 4, true);
    }
    return symbols;
}

/**
 * Parse the FlashDevice descriptor.
 *
 * Fixed layout from FlashOS.h: a version, a 128-byte name, the geometry, then
 * a list of sector sizes terminated by a pair of 0xffffffff.
 */
function parseDeviceDescriptor(view, bytes, section) {
    const at = section.offset;

    const sectors = [];
    for (let offset = at + 160; offset + 8 <= at + section.size; offset += 8) {
        const size    = view.getUint32(offset, true);
        const address = view.getUint32(offset + 4, true);
        if (size === 0xffffffff && address === 0xffffffff) break;
        sectors.push({ size, address });
    }

    const type = view.getUint16(at + 130, true);
    return {
        version:  view.getUint16(at, true),
        name:     readString(bytes, at + 2),
        type:     DEVICE_TYPES[type] ?? `unknown (${type})`,
        address:  view.getUint32(at + 132, true),
        size:     view.getUint32(at + 136, true),
        pageSize: view.getUint32(at + 140, true),
        // What an erased byte reads back as. Not always 0xff.
        valueEmpty:     view.getUint8(at + 148),
        programTimeout: view.getUint32(at + 152, true),
        eraseTimeout:   view.getUint32(at + 156, true),
        sectors,
    };
}

/**
 * Parse a `.FLM` flash algorithm.
 *
 * @param {ArrayBuffer|Uint8Array} input  Contents of the .FLM file
 * @returns {{device: object, code: Uint8Array, codeAddress: number,
 *            zeroInitSize: number, symbols: object, entries: object}}
 *   `code` is the image to copy into target RAM, `codeAddress` the address it
 *   was linked at (almost always 0, so it relocates freely), `zeroInitSize`
 *   the extra zeroed bytes the algorithm expects after it, and `entries` the
 *   offset of each available function within `code`.
 */
export function parseFLM(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length < 52 || view.getUint32(0, true) !== ELF_MAGIC) {
        throw new Error('not an ELF file: this does not look like a .FLM');
    }
    if (view.getUint16(0x12, true) !== EM_ARM) {
        throw new Error('not an ARM object: wrong architecture for a flash algorithm');
    }

    const sections = readSections(view, bytes);
    const symbols = readSymbols(view, bytes, sections);

    const descriptor = sections.find(s => s.name === DEVICE_SECTION);
    if (!descriptor) {
        throw new Error(`no ${DEVICE_SECTION} section: not a CMSIS flash algorithm`);
    }
    const device = parseDeviceDescriptor(view, bytes, descriptor);

    // Everything the target needs in RAM, in address order. The descriptor is
    // metadata for us, not code for the chip, so it stays out.
    const loadable = sections
        .filter(s => (s.flags & SHF_ALLOC) && s.size > 0 && s !== descriptor)
        .sort((a, b) => a.addr - b.addr);

    const progbits = loadable.filter(s => s.type === SHT_PROGBITS);
    if (!progbits.length) throw new Error('the algorithm has no loadable code');

    const codeAddress = progbits[0].addr;
    const last = progbits[progbits.length - 1];
    const codeSize = last.addr + last.size - codeAddress;

    // Sections are laid out by address, not by file order, and there may be
    // gaps between them: place each one where it belongs.
    const code = new Uint8Array(codeSize);
    for (const section of progbits) {
        code.set(
            bytes.subarray(section.offset, section.offset + section.size),
            section.addr - codeAddress);
    }

    // .bss and friends: the chip must see these zeroed, and they sit after the
    // code, so the caller has to reserve room for them in RAM.
    const zeroInitSize = loadable
        .filter(s => s.type === SHT_NOBITS)
        .reduce((total, s) => total + s.size, 0);

    const entries = {};
    for (const name of ALGO_FUNCTIONS) {
        // Thumb symbols carry bit 0 set; the real address is even.
        if (name in symbols) entries[name] = (symbols[name] & ~1) - codeAddress;
    }
    if (!('Init' in entries) || !('ProgramPage' in entries)) {
        throw new Error('the algorithm is missing Init or ProgramPage');
    }

    return { device, code, codeAddress, zeroInitSize, symbols, entries };
}
