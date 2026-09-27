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
 * Fetch a flash algorithm from its vendor's CMSIS pack.
 *
 * This library ships no `.FLM` of its own, because vendor licences generally
 * do not allow it — see the README. What it can do is save you the trip: this
 * downloads the algorithm from the vendor, so the file reaches you from them,
 * under their terms.
 *
 *   node tools/fetch-flm.mjs --search renesas
 *   node tools/fetch-flm.mjs --pack Renesas.RA_DFP
 *   node tools/fetch-flm.mjs --pack Renesas.RA_DFP --match RA4M1_256K --out .
 *
 * A `.pack` is a zip, and HTTP range requests can read one without downloading
 * it: the Renesas RA pack is 90 MB and the algorithm inside is 23 KB. Only the
 * 23 KB come down the wire.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, basename } from 'node:path';

const PACK_INDEX = 'https://www.keil.com/pack/index.pidx';

// Some vendor sites answer plain requests with a redirect to a browser page.
const HEADERS = { 'user-agent': 'Mozilla/5.0 (cmsis-dap-webhid fetch-flm)' };

const EOCD_SIGNATURE   = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function fail(message) {
    console.error(message);
    process.exit(1);
}

/** Minimal flag parsing: --name value, plus bare --flag. */
function parseArguments(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const name = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { options[name] = next; i++; }
        else options[name] = true;
    }
    return options;
}

async function get(url, range) {
    const headers = { ...HEADERS };
    if (range) headers.range = `bytes=${range[0]}-${range[1]}`;

    const response = await fetch(url, { headers, redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${url} answered HTTP ${response.status}`);
    }
    // A server that ignores Range sends 200 and the whole file; catching that
    // matters, or we would slice bytes out of the wrong offset.
    if (range && response.status !== 206) {
        throw new Error('this server does not support range requests');
    }
    return Buffer.from(await response.arrayBuffer());
}

/** The pack index, as {vendor, name, version, url} rows. */
async function loadIndex() {
    const xml = (await get(PACK_INDEX)).toString('utf8');
    const rows = [];
    const pattern = /<pdsc\s+url="([^"]*)"\s+vendor="([^"]*)"\s+name="([^"]*)"\s+version="([^"]*)"/g;
    for (const match of xml.matchAll(pattern)) {
        rows.push({ url: match[1], vendor: match[2], name: match[3], version: match[4] });
    }
    if (!rows.length) throw new Error('the pack index came back empty or in an unexpected shape');
    return rows;
}

/**
 * List a remote zip's entries by reading only its central directory.
 */
async function listRemoteZip(url) {
    const head = await fetch(url, { method: 'HEAD', headers: HEADERS, redirect: 'follow' });
    if (!head.ok) throw new Error(`${url} answered HTTP ${head.status}`);

    const total = Number(head.headers.get('content-length'));
    if (!total) throw new Error('the server did not say how big the pack is');

    // The end-of-central-directory record is last, after a comment of unknown
    // length, so read a tail generous enough to contain it.
    const tailSize = Math.min(total, 66560);
    const tail = await get(url, [total - tailSize, total - 1]);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no end-of-central-directory found: not a zip?');

    const directorySize   = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff) {
        throw new Error('this pack uses ZIP64, which this tool does not read');
    }

    const directory = await get(
        url, [directoryOffset, directoryOffset + directorySize - 1]);

    const entries = [];
    let at = 0;
    while (at + 46 <= directory.length &&
           directory.readUInt32LE(at) === CENTRAL_SIGNATURE) {
        const nameLength    = directory.readUInt16LE(at + 28);
        const extraLength   = directory.readUInt16LE(at + 30);
        const commentLength = directory.readUInt16LE(at + 32);
        entries.push({
            name:            directory.toString('utf8', at + 46, at + 46 + nameLength),
            method:          directory.readUInt16LE(at + 10),
            crc:             directory.readUInt32LE(at + 16),
            compressedSize:  directory.readUInt32LE(at + 20),
            size:            directory.readUInt32LE(at + 24),
            localHeader:     directory.readUInt32LE(at + 42),
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return { total, entries };
}

/** Pull one entry out of a remote zip. */
async function extractRemote(url, entry) {
    // The local header repeats the name and carries its own extra field, whose
    // length differs from the central one, so it has to be read to find the data.
    const header = await get(url, [entry.localHeader, entry.localHeader + 29]);
    const nameLength  = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);

    const start = entry.localHeader + 30 + nameLength + extraLength;
    const raw = await get(url, [start, start + entry.compressedSize - 1]);

    const data = entry.method === 0 ? raw
        : entry.method === 8 ? inflateRawSync(raw)
        : fail(`${entry.name} uses compression method ${entry.method}, unsupported`);

    if (crc32(data) !== entry.crc) {
        throw new Error(`${entry.name} failed its checksum: the download is corrupt`);
    }
    return data;
}

let crcTable = null;
function crc32(buffer) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c;
        }
    }
    let crc = -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
}

const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;

async function main() {
    const options = parseArguments(process.argv.slice(2));

    if (options.help || (!options.search && !options.pack)) {
        console.log(`Fetch a flash algorithm from its vendor's CMSIS pack.

  --search <text>          find packs whose vendor or name matches
  --pack <Vendor.Name>     use this pack; without --match, lists its .FLM files
  --match <text>           download the .FLM files whose name contains this
  --out <dir>              where to write them (default: the current directory)

The .FLM comes from the vendor and carries the vendor's licence, which is
usually not one that allows redistribution. Check it before you ship it.`);
        return;
    }

    const index = await loadIndex();

    if (options.search) {
        const needle = String(options.search).toLowerCase();
        const hits = index.filter(p =>
            `${p.vendor}.${p.name}`.toLowerCase().includes(needle));
        if (!hits.length) return console.log(`nothing in the index matches "${options.search}"`);
        for (const pack of hits) {
            console.log(`${pack.vendor}.${pack.name}`.padEnd(38), pack.version);
        }
        console.log(`\n${hits.length} pack(s). Pick one with --pack.`);
        return;
    }

    const wanted = String(options.pack).toLowerCase();
    const pack = index.find(p => `${p.vendor}.${p.name}`.toLowerCase() === wanted);
    if (!pack) fail(`no pack called ${options.pack} in the index. Try --search.`);

    // The index gives the directory the .pdsc lives in; the .pack sits beside it.
    const base = pack.url.endsWith('/') ? pack.url : pack.url + '/';
    const url = `${base}${pack.vendor}.${pack.name}.${pack.version}.pack`;

    console.error(`reading ${pack.vendor}.${pack.name} ${pack.version}`);
    const { total, entries } = await listRemoteZip(url);

    const algorithms = entries.filter(e => /\.flm$/i.test(e.name));
    if (!algorithms.length) fail('this pack contains no .FLM files');

    if (!options.match) {
        console.error(`pack is ${kb(total)}; ${algorithms.length} algorithms inside:\n`);
        for (const entry of algorithms) {
            console.log(`  ${entry.name.padEnd(42)} ${kb(entry.size)}`);
        }
        console.error('\nPick one with --match.');
        return;
    }

    const needle = String(options.match).toLowerCase();
    const chosen = algorithms.filter(e => e.name.toLowerCase().includes(needle));
    if (!chosen.length) fail(`no algorithm in this pack matches "${options.match}"`);

    const out = options.out ? String(options.out) : '.';
    mkdirSync(out, { recursive: true });

    for (const entry of chosen) {
        const data = await extractRemote(url, entry);
        const path = join(out, basename(entry.name));
        writeFileSync(path, data);
        console.log(`${path}  ${kb(data.length)}`);
    }

    console.error(`\nDownloaded ${chosen.length} file(s) out of a ${kb(total)} pack.`);
    console.error('These are the vendor\'s, under the vendor\'s licence. Do not assume');
    console.error('you may redistribute them.');
}

main().catch(error => fail(`error: ${error.message}`));
