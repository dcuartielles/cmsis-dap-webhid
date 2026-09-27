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
 * do not allow it — see the README. What it can do is save you the trip: the
 * file comes from the vendor, under their terms.
 *
 *   node tools/fetch-flm.mjs --search renesas
 *   node tools/fetch-flm.mjs --pack Renesas.RA_DFP --device R7FA4M1AB
 *   node tools/fetch-flm.mjs --pack Renesas.RA_DFP --match RA4M1_256K --out .
 *
 * All the work happens in `src/pack.js`; this is the command-line skin.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

import {
    fetchPackIndex, findPack, packUrl, openRemotePack, selectAlgorithm, ramFor,
} from '../src/pack.js';

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

const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;
const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');

const HELP = `Fetch a flash algorithm from its vendor's CMSIS pack.

  --search <text>        find packs whose vendor or name matches
  --pack <Vendor.Name>   the pack to read
  --device <name>        the chip, e.g. R7FA4M1AB or a full part number.
                         Its descriptor also gives the RAM the algorithm needs
  --match <text>         pick an algorithm by filename instead
  --out <dir>            where to write (default: the current directory)
  --stdout               write the algorithm to standard output, not to a file

With --pack and nothing else, lists the algorithms inside.

The .FLM comes from the vendor and carries the vendor's licence, which is
usually not one that allows redistribution. Check it before you ship it.`;

async function main() {
    const options = parseArguments(process.argv.slice(2));

    if (options.help || (!options.search && !options.pack)) {
        console.log(HELP);
        return;
    }

    const index = await fetchPackIndex();

    if (options.search) {
        const needle = String(options.search).toLowerCase();
        const hits = index.filter(p => p.id.toLowerCase().includes(needle));
        if (!hits.length) return console.log(`nothing matches "${options.search}"`);
        for (const pack of hits) console.log(pack.id.padEnd(38), pack.version);
        console.log(`\n${hits.length} pack(s). Pick one with --pack.`);
        return;
    }

    const pack = findPack(index, options.pack);
    if (!pack) fail(`no pack called ${options.pack} in the index. Try --search.`);

    console.error(`reading ${pack.id} ${pack.version}`);
    const archive = await openRemotePack(packUrl(pack));

    // Nothing chosen: show what is in there and stop.
    if (!options.device && !options.match) {
        const algorithms = archive.entries.filter(e => /\.flm$/i.test(e.name));
        if (!algorithms.length) fail('this pack contains no .FLM files');
        console.error(`pack is ${kb(archive.size)}; ${algorithms.length} algorithms inside:\n`);
        for (const entry of algorithms) {
            console.log(`  ${entry.name.padEnd(42)} ${kb(entry.size)}`);
        }
        console.error('\nPick one with --device or --match.');
        return;
    }

    const result = await selectAlgorithm(archive, {
        device: options.device === true ? undefined : options.device,
        match: options.match === true ? undefined : options.match,
    });

    if (result.device) {
        const { device, algorithm, ram } = result;
        console.error(`\n${device.name}  ${device.core ?? ''}  ${device.family ?? ''}`.trimEnd());
        console.error(`  algorithm  ${algorithm.name}`);
        console.error(`  flash      ${hex(algorithm.start)} + ${kb(algorithm.size)}`);
        console.error(`  RAM        ${hex(ram.start)} + ${kb(ram.size)} for the algorithm`);
        const chipRam = ramFor(device);
        if (chipRam) {
            console.error(`             (the chip has ${kb(chipRam.size)} at ${hex(chipRam.start)})`);
        }
        console.error('');
    }

    if (options.stdout) {
        process.stdout.write(result.data);
    } else {
        const out = options.out && options.out !== true ? String(options.out) : '.';
        mkdirSync(out, { recursive: true });
        const path = join(out, basename(result.algorithm.name));
        writeFileSync(path, result.data);
        console.log(`${path}  ${kb(result.data.length)}`);
    }

    console.error(`Fetched ${kb(result.data.length)} out of a ${kb(archive.size)} pack.`);
    console.error('This is the vendor\'s file, under the vendor\'s licence. Do not');
    console.error('assume you may redistribute it.');
}

main().catch(error => fail(`error: ${error.message}`));
