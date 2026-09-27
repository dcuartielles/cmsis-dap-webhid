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
 * Intel HEX files.
 *
 * Worth supporting for one reason: **a `.hex` carries the addresses it belongs
 * at, and a `.bin` does not**. Flashing a raw binary means someone has to know
 * where it goes, and getting that wrong writes a perfectly valid image to the
 * wrong place — which verifies clean and then does not run.
 *
 * Arduino's Uno R4 sketches link at `0x4000`, above a bootloader that lives at
 * `0x0`. Writing such a sketch to `0x0` erases the bootloader and leaves an
 * image whose absolute addresses all point 16 KB low. The board stops
 * responding to USB entirely. If the file says where it goes, that cannot
 * happen.
 */

const RECORD = {
    DATA: 0x00,
    END: 0x01,
    EXTENDED_SEGMENT: 0x02,
    START_SEGMENT: 0x03,
    EXTENDED_LINEAR: 0x04,
    START_LINEAR: 0x05,
};

/**
 * Parse an Intel HEX file.
 *
 * @param {string} text
 * @returns {{segments: Array<{address: number, data: Uint8Array}>,
 *            start: number, end: number, entry: number|undefined}}
 *   `segments` are contiguous runs in address order — a HEX file may leave
 *   gaps, and filling them with padding would overwrite things it never
 *   mentioned.
 */
export function parseIntelHex(text) {
    const chunks = [];
    let upper = 0;          // from the extended-address records
    let entry;
    let sawEnd = false;

    const lines = String(text).split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n].trim();
        if (!line) continue;
        if (line[0] !== ':') {
            throw new Error(`line ${n + 1} does not start with ':': not Intel HEX`);
        }
        if (line.length < 11 || line.length % 2 === 0) {
            throw new Error(`line ${n + 1} is malformed`);
        }

        const bytes = new Uint8Array((line.length - 1) / 2);
        for (let i = 0; i < bytes.length; i++) {
            const byte = parseInt(line.substr(1 + i * 2, 2), 16);
            if (Number.isNaN(byte)) {
                throw new Error(`line ${n + 1} has a non-hexadecimal digit`);
            }
            bytes[i] = byte;
        }

        const length = bytes[0];
        const offset = (bytes[1] << 8) | bytes[2];
        const type = bytes[3];
        const data = bytes.subarray(4, 4 + length);

        if (bytes.length !== length + 5) {
            throw new Error(`line ${n + 1} declares ${length} bytes but carries a different number`);
        }

        // The checksum is the two's complement of the sum of every other byte.
        let sum = 0;
        for (let i = 0; i < bytes.length - 1; i++) sum += bytes[i];
        if (((sum + bytes[bytes.length - 1]) & 0xff) !== 0) {
            throw new Error(`line ${n + 1} fails its checksum`);
        }

        switch (type) {
            case RECORD.DATA:
                chunks.push({ address: (upper + offset) >>> 0, data: data.slice() });
                break;
            case RECORD.END:
                sawEnd = true;
                break;
            case RECORD.EXTENDED_LINEAR:
                upper = ((data[0] << 8) | data[1]) * 0x10000;
                break;
            case RECORD.EXTENDED_SEGMENT:
                upper = ((data[0] << 8) | data[1]) * 16;
                break;
            case RECORD.START_LINEAR:
                entry = ((data[0] << 24) | (data[1] << 16) |
                         (data[2] << 8) | data[3]) >>> 0;
                break;
            case RECORD.START_SEGMENT:
                // CS:IP, meaningless on ARM; recorded rather than rejected.
                entry = (((data[0] << 8) | data[1]) * 16 +
                         ((data[2] << 8) | data[3])) >>> 0;
                break;
            default:
                throw new Error(`line ${n + 1} has unknown record type 0x${type.toString(16)}`);
        }
    }

    if (!sawEnd) throw new Error('the file has no end-of-file record: it may be truncated');
    if (!chunks.length) throw new Error('the file contains no data');

    // Merge runs that touch. Records usually arrive in order and 16 bytes at a
    // time, so without this a 40 KB image would be thousands of segments.
    chunks.sort((a, b) => a.address - b.address);
    const segments = [];
    for (const chunk of chunks) {
        const last = segments[segments.length - 1];
        if (last && last.address + last.data.length === chunk.address) {
            const merged = new Uint8Array(last.data.length + chunk.data.length);
            merged.set(last.data);
            merged.set(chunk.data, last.data.length);
            last.data = merged;
        } else {
            segments.push({ address: chunk.address, data: chunk.data });
        }
    }

    const last = segments[segments.length - 1];
    return {
        segments,
        start: segments[0].address,
        end: last.address + last.data.length,
        entry,
    };
}

/**
 * Flatten segments into one image, filling any gaps.
 *
 * Convenient, but it means writing over the gaps too: only do this when the
 * whole span is yours to overwrite.
 *
 * @param {Array<{address: number, data: Uint8Array}>} segments
 * @param {number} [fill=0xff]  What erased flash reads as
 */
export function flatten(segments, fill = 0xff) {
    if (!segments.length) throw new Error('there are no segments to flatten');
    const start = segments[0].address;
    const last = segments[segments.length - 1];
    const image = new Uint8Array(last.address + last.data.length - start);
    image.fill(fill);
    for (const segment of segments) {
        image.set(segment.data, segment.address - start);
    }
    return { address: start, data: image };
}

/**
 * Read a firmware file, taking its addresses from the file when it has them.
 *
 * @param {string|ArrayBuffer|Uint8Array} content
 * @param {object} [options]
 * @param {string} [options.name]  Filename, used to tell the formats apart
 * @param {number} [options.address]  Where a raw binary goes; required for one
 * @returns {{address: number, data: Uint8Array, format: string, entry?: number}}
 */
export function readFirmware(content, options = {}) {
    const looksLikeHex = typeof content === 'string' ||
        /\.hex$/i.test(options.name ?? '');

    if (looksLikeHex) {
        const text = typeof content === 'string'
            ? content
            : new TextDecoder().decode(content);
        const parsed = parseIntelHex(text);
        const { address, data } = flatten(parsed.segments);
        return { address, data, format: 'ihex', entry: parsed.entry };
    }

    const data = content instanceof Uint8Array
        ? content : new Uint8Array(content);
    if (options.address === undefined) {
        throw new Error(
            'a raw binary does not say where it goes: give an address, or use ' +
            'a .hex file, which carries its own');
    }
    return { address: options.address, data, format: 'bin' };
}
