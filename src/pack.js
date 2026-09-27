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
 * Read a vendor's CMSIS pack over the network, without downloading it.
 *
 * A `.pack` is a zip, and HTTP range requests can read one in place: fetch the
 * tail to find the central directory, parse it, then fetch only the bytes of
 * the entry you want. The Renesas RA pack is 88 MB and one algorithm inside it
 * is 23 KB — only the 23 KB travel.
 *
 * Nothing here touches the filesystem. Everything comes back as bytes in
 * memory, ready to hand to `parseFLM`.
 *
 * The pack descriptor (`.pdsc`) inside also says, per device, **which**
 * algorithm to use and **where that chip's RAM is** — the two things you would
 * otherwise have to look up in a datasheet.
 *
 * **In a browser this will not work against the vendors as they stand today.**
 * Measured from a GitHub Pages origin: keil.com, its Azure mirror,
 * packs.download.arm.com and www2.renesas.eu all fail CORS. The code is
 * browser-ready; the hosts are not. In Node it works directly.
 */

const PACK_INDEX = 'https://www.keil.com/pack/index.pidx';

// Some vendor sites answer bare requests with a redirect to a browser page.
const USER_AGENT = 'Mozilla/5.0 (cmsis-dap-webhid)';

const EOCD_SIGNATURE    = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Node lets us set a user agent; browsers refuse, and do not need one. */
const headers = (extra = {}) => {
    const base = { ...extra };
    if (typeof window === 'undefined') base['user-agent'] = USER_AGENT;
    return base;
};

async function get(url, range) {
    const options = { redirect: 'follow', headers: headers(
        range ? { range: `bytes=${range[0]}-${range[1]}` } : {}) };

    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

    // A server that ignores Range replies 200 with the whole file; catching
    // that matters, or we would slice bytes at the wrong offset.
    if (range && response.status !== 206) {
        throw new Error('this server does not support range requests');
    }
    return new Uint8Array(await response.arrayBuffer());
}

let crcTable = null;
function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c;
        }
    }
    let crc = -1;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
}

/** Inflate raw deflate data, using whichever API the runtime provides. */
async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'function') {
        const stream = new Blob([bytes]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const { inflateRawSync } = await import('node:zlib');
    return new Uint8Array(inflateRawSync(bytes));
}

/** The published pack index, as {vendor, name, version, url} rows. */
export async function fetchPackIndex() {
    const xml = new TextDecoder().decode(await get(PACK_INDEX));
    const rows = [];
    const pattern =
        /<pdsc\s+url="([^"]*)"\s+vendor="([^"]*)"\s+name="([^"]*)"\s+version="([^"]*)"/g;
    for (const match of xml.matchAll(pattern)) {
        rows.push({
            url: match[1], vendor: match[2], name: match[3], version: match[4],
            id: `${match[2]}.${match[3]}`,
        });
    }
    if (!rows.length) throw new Error('the pack index came back empty or in an unexpected shape');
    return rows;
}

/** Find a pack in the index by "Vendor.Name", case-insensitively. */
export function findPack(index, id) {
    const wanted = String(id).toLowerCase();
    return index.find(pack => pack.id.toLowerCase() === wanted);
}

/** The download URL of a pack: the index gives the directory its .pdsc is in. */
export function packUrl(pack) {
    const base = pack.url.endsWith('/') ? pack.url : pack.url + '/';
    return `${base}${pack.vendor}.${pack.name}.${pack.version}.pack`;
}

/**
 * Open a zip for reading through any random-access source.
 *
 * Only the central directory is read up front; entries are fetched on demand.
 * The source is just `read(start, end)`, so the same code serves an HTTP range
 * request and a local File the user dropped on the page.
 *
 * @param {object} source
 * @param {number} source.size  Total length of the archive
 * @param {(start: number, end: number) => Promise<Uint8Array>} source.read
 *   Inclusive byte range, as HTTP Range means it
 * @returns {Promise<{size: number, entries: Array, read: (name) => Promise<Uint8Array>}>}
 */
export async function openZip({ size, read: readRange }) {
    if (!size) throw new Error('the archive has no length');

    // The end-of-central-directory record sits last, after a comment of
    // unknown length, so read a tail generous enough to hold it.
    const tail = await readRange(Math.max(0, size - 66560), size - 1);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no end-of-central-directory found: not a zip?');

    const directorySize   = view.getUint32(eocd + 12, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    if (directoryOffset === 0xffffffff) {
        throw new Error('this pack uses ZIP64, which is not supported');
    }

    const directory = await readRange(
        directoryOffset, directoryOffset + directorySize - 1);
    const dv = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const decoder = new TextDecoder();

    const entries = [];
    let at = 0;
    while (at + 46 <= directory.length && dv.getUint32(at, true) === CENTRAL_SIGNATURE) {
        const nameLength    = dv.getUint16(at + 28, true);
        const extraLength   = dv.getUint16(at + 30, true);
        const commentLength = dv.getUint16(at + 32, true);
        entries.push({
            name: decoder.decode(directory.subarray(at + 46, at + 46 + nameLength)),
            method:         dv.getUint16(at + 10, true),
            crc:            dv.getUint32(at + 16, true),
            compressedSize: dv.getUint32(at + 20, true),
            size:           dv.getUint32(at + 24, true),
            localHeader:    dv.getUint32(at + 42, true),
        });
        at += 46 + nameLength + extraLength + commentLength;
    }

    async function read(name) {
        const wanted = String(name).toLowerCase();
        const entry = entries.find(e => e.name.toLowerCase() === wanted)
            ?? entries.find(e => e.name.toLowerCase().endsWith('/' + wanted));
        if (!entry) throw new Error(`the pack has no entry called ${name}`);

        // The local header repeats the name and carries its own extra field,
        // whose length differs from the central one, so it must be read to
        // find where the data actually starts.
        const header = await readRange(entry.localHeader, entry.localHeader + 29);
        const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const start = entry.localHeader + 30
            + hv.getUint16(26, true) + hv.getUint16(28, true);

        const raw = await readRange(start, start + entry.compressedSize - 1);
        const data = entry.method === 0 ? raw
            : entry.method === 8 ? await inflateRaw(raw)
            : (() => { throw new Error(
                `${entry.name} uses compression method ${entry.method}`); })();

        if (crc32(data) !== entry.crc) {
            throw new Error(`${entry.name} failed its checksum: the download is corrupt`);
        }
        return data;
    }

    return { size, entries, read };
}

/** Open a pack on a vendor's server, without downloading it. */
export async function openRemotePack(url) {
    const head = await fetch(url, { method: 'HEAD', headers: headers(), redirect: 'follow' });
    if (!head.ok) throw new Error(`${url} answered HTTP ${head.status}`);

    const size = Number(head.headers.get('content-length'));
    if (!size) throw new Error('the server did not say how big the pack is');

    return openZip({ size, read: (start, end) => get(url, [start, end]) });
}

/**
 * Open a pack the user already has: a File from an `<input type=file>`, or any
 * Blob. Useful in a browser, where the vendor servers cannot be reached
 * directly — download the pack normally, then drop it on the page.
 */
export async function openPackFile(blob) {
    return openZip({
        size: blob.size,
        read: async (start, end) =>
            new Uint8Array(await blob.slice(start, end + 1).arrayBuffer()),
    });
}

const attribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : undefined;
};
const number = value => (value === undefined ? undefined : parseInt(value, 16) || parseInt(value, 10) || 0);

/**
 * Parse a pack descriptor and return its devices.
 *
 * `<algorithm>` and `<memory>` are declared at family or sub-family level and
 * inherited by the devices below, so the tree has to be walked rather than
 * scanned: a device's real settings are everything its ancestors declared.
 */
export function parseDescriptor(xml) {
    const devices = [];
    const stack = [{ algorithms: [], memories: [], attributes: {} }];

    const tags = xml.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g);
    for (const [, closing, name, rest, selfClosing] of tags) {
        const container = ['family', 'subFamily', 'device', 'variant'].includes(name);

        if (closing) {
            if (container && stack.length > 1) stack.pop();
            continue;
        }

        const top = stack[stack.length - 1];

        if (name === 'algorithm') {
            top.algorithms.push({
                name:     attribute(rest, 'name'),
                start:    number(attribute(rest, 'start')),
                size:     number(attribute(rest, 'size')),
                ramStart: number(attribute(rest, 'RAMstart')),
                ramSize:  number(attribute(rest, 'RAMsize')),
                default:  attribute(rest, 'default') === '1',
            });
            continue;
        }
        if (name === 'memory') {
            top.memories.push({
                name:    attribute(rest, 'name') ?? attribute(rest, 'id'),
                access:  attribute(rest, 'access') ?? '',
                start:   number(attribute(rest, 'start')),
                size:    number(attribute(rest, 'size')),
                default: attribute(rest, 'default') === '1',
            });
            continue;
        }
        if (name === 'processor') {
            top.attributes.core = attribute(rest, 'Dcore');
            continue;
        }

        if (!container) continue;

        // Collapse the whole ancestry: outer declarations first, so that a
        // sub-family can override what its family said.
        const inherited = {
            algorithms: stack.flatMap(level => level.algorithms),
            memories:   stack.flatMap(level => level.memories),
            attributes: Object.assign({}, ...stack.map(level => level.attributes)),
        };
        const own = {
            family:    attribute(rest, 'Dfamily'),
            subFamily: attribute(rest, 'DsubFamily'),
            core:      attribute(rest, 'Dcore'),
            vendor:    attribute(rest, 'Dvendor'),
        };
        for (const [key, value] of Object.entries(own)) {
            if (value !== undefined) inherited.attributes[key] = value;
        }

        const deviceName = attribute(rest, 'Dname') ?? attribute(rest, 'Dvariant');
        if (deviceName && (name === 'device' || name === 'variant')) {
            devices.push({
                name: deviceName,
                ...inherited.attributes,
                algorithms: inherited.algorithms,
                memories: inherited.memories,
            });
        }

        if (!selfClosing) {
            stack.push({
                algorithms: [],
                memories: [],
                // Only what this level actually declares: an undefined key
                // would otherwise overwrite what an ancestor said.
                attributes: Object.fromEntries(
                    Object.entries(own).filter(([, value]) => value !== undefined)),
            });
        }
    }
    return devices;
}

/** The writable memory a flash algorithm can be staged in. */
export function ramFor(device) {
    const writable = device.memories.filter(m => /w/.test(m.access) && m.size);
    return writable.find(m => m.default) ?? writable[0];
}

/**
 * Pick an algorithm out of an already-open pack.
 *
 * @param {object} archive  From openRemotePack() or openPackFile()
 * @param {object} options
 * @param {string} [options.device] Device name, or a prefix of it
 * @param {string} [options.match]  Pick by algorithm filename instead
 */
export async function selectAlgorithm(archive, { device, match } = {}) {
    if (match) {
        const needle = String(match).toLowerCase();
        const file = archive.entries.find(e =>
            /\.flm$/i.test(e.name) && e.name.toLowerCase().includes(needle));
        if (!file) throw new Error(`no algorithm matches "${match}"`);
        return {
            device: null, ram: null,
            algorithm: { name: file.name },
            data: await archive.read(file.name),
        };
    }

    if (!device) throw new Error('pass either a device or a match');

    const descriptorEntry = archive.entries.find(e => /\.pdsc$/i.test(e.name));
    if (!descriptorEntry) throw new Error('this pack has no .pdsc descriptor');

    const descriptor = new TextDecoder().decode(await archive.read(descriptorEntry.name));
    const devices = parseDescriptor(descriptor);

    const wanted = String(device).toLowerCase();
    const found = devices.find(d => d.name.toLowerCase() === wanted)
        ?? devices.find(d => d.name.toLowerCase().startsWith(wanted))
        // Chip part numbers carry a package suffix the descriptor omits, so
        // "R7FA4M1AB3CFM" has to find the device called "R7FA4M1AB".
        ?? devices.find(d => wanted.startsWith(d.name.toLowerCase()));
    if (!found) throw new Error(`this pack declares no device matching "${device}"`);

    // Prefer the default algorithm for the chip's own code flash: a part often
    // also declares one for its data flash and its configuration area.
    const algorithm = found.algorithms.find(a => a.default && a.start === 0)
        ?? found.algorithms.find(a => a.default)
        ?? found.algorithms[0];
    if (!algorithm) throw new Error(`${found.name} declares no flash algorithm`);

    return {
        device: found,
        algorithm,
        // The vendor states how much RAM the algorithm may use, which is
        // usually less than the chip has.
        ram: { start: algorithm.ramStart, size: algorithm.ramSize },
        data: await archive.read(algorithm.name),
    };
}

/**
 * Fetch a flash algorithm by chip name — over the network, nothing written to
 * disk. The descriptor inside the pack supplies both which algorithm to use
 * and where that chip's RAM is.
 *
 * @param {object} options
 * @param {string} [options.pack]   "Vendor.Name", e.g. "Renesas.RA_DFP"
 * @param {Blob}   [options.file]   A pack the user already has, instead
 * @param {string} [options.device] Device name or part number
 * @param {string} [options.match]  Pick an algorithm by filename instead
 * @returns {Promise<{device, algorithm, ram, data: Uint8Array, pack}>}
 *
 * @example
 * const { data, ram } = await fetchAlgorithm({
 *     pack: 'Renesas.RA_DFP', device: 'R7FA4M1AB' });
 * const flash = new FlashProgrammer(target, parseFLM(data), {
 *     ramAddress: ram.start, ramSize: ram.size });
 */
export async function fetchAlgorithm({ pack, file, device, match }) {
    if (file) {
        const archive = await openPackFile(file);
        return { pack: null, ...await selectAlgorithm(archive, { device, match }) };
    }

    const index = await fetchPackIndex();
    const entry = findPack(index, pack);
    if (!entry) throw new Error(`no pack called ${pack} in the index`);

    const archive = await openRemotePack(packUrl(entry));
    return { pack: entry, ...await selectAlgorithm(archive, { device, match }) };
}
