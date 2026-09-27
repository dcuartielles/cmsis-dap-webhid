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
 * Write flash by running the vendor's own algorithm on the target.
 *
 * Nobody reimplements flash drivers. A debugger copies the vendor's compiled
 * `Init` / `EraseSector` / `ProgramPage` routines into the chip's RAM, points
 * the program counter at them and lets the chip program itself. OpenOCD and
 * pyOCD both work this way; so does this.
 *
 * The trick that makes it work is the return address. Each call sets the link
 * register to a word of RAM holding a `BKPT` instruction, so when the routine
 * returns the core halts and the debugger regains control, with the result
 * still sitting in R0.
 *
 * Supply the algorithm yourself: see `flm.js` for why none is bundled.
 */

import { CORE_REG, DHCSR, REG, SPECIAL } from './debug.js';

/** FlashOS operation codes, passed to Init and UnInit. */
export const OPERATION = { ERASE: 1, PROGRAM: 2, VERIFY: 3 };

/** `BKPT #0` twice over, so a halfword-aligned return still lands on one. */
const BREAKPOINT_WORD = 0xbe00be00;

/** DHCSR only accepts writes carrying this key in its upper half. */
const DBGKEY = 0xa05f0000;

const DEFAULTS = {
    // Enough for the vendor routines, which are not deeply recursive.
    stackSize: 1024,
    // SWD clock reported to Init. Informational for most algorithms.
    clock: 10e6,
    // Algorithm timeouts are advisory and often optimistic.
    timeoutFactor: 4,
    minimumTimeout: 2000,
};

const align = (value, boundary) =>
    Math.ceil(value / boundary) * boundary;

/**
 * Runs a parsed `.FLM` on a target.
 *
 * @example
 * const algorithm = parseFLM(await file.arrayBuffer());
 * const flash = new FlashProgrammer(target, algorithm, {
 *     ramAddress: 0x20000000, ramSize: 0x8000,
 * });
 * await flash.program(0x0, firmware, { onProgress: p => console.log(p) });
 */
export class FlashProgrammer {
    /**
     * @param {object} target  A connected dapjs CortexM
     * @param {object} algorithm  Output of parseFLM()
     * @param {object} options
     * @param {number} options.ramAddress  Where the chip's RAM starts
     * @param {number} options.ramSize     How much of it may be used
     * @param {number} [options.stackSize=1024]
     * @param {number} [options.bufferSize]  Defaults to one flash page
     */
    constructor(target, algorithm, options = {}) {
        if (!options.ramAddress && options.ramAddress !== 0) {
            throw new Error('ramAddress is required: the algorithm runs from RAM');
        }
        this.target = target;
        this.algorithm = algorithm;
        this.device = algorithm.device;
        this.options = { ...DEFAULTS, ...options };
        this.loaded = false;

        const { ramAddress } = this.options;
        const pageSize = this.device.pageSize;
        const bufferSize = this.options.bufferSize ?? pageSize;

        // RAM layout, in order: code, zero-init data, the breakpoint word we
        // return to, the stack growing down from its top, then the page buffer.
        this.codeBase = ramAddress;
        const afterCode = align(
            ramAddress + algorithm.code.length + algorithm.zeroInitSize, 4);

        this.returnAddress = afterCode;
        this.stackTop = align(this.returnAddress + 4 + this.options.stackSize, 8);
        this.bufferAddress = this.stackTop;
        this.staticBase = this.codeBase + algorithm.dataOffset;

        const needed = this.bufferAddress + bufferSize - ramAddress;
        if (options.ramSize && needed > options.ramSize) {
            throw new Error(
                `the algorithm needs ${needed} bytes of RAM but only ` +
                `${options.ramSize} are available`);
        }
        this.bufferSize = bufferSize;
    }

    /** Copy the algorithm into the chip's RAM. Safe to call more than once. */
    async load() {
        await this.target.halt();

        const { code } = this.algorithm;
        // writeBlock takes words, so pad the image up to a word boundary.
        const padded = new Uint8Array(align(code.length, 4));
        padded.set(code);
        await this.target.writeBlock(
            this.codeBase,
            new Uint32Array(padded.buffer, padded.byteOffset, padded.length / 4));

        if (this.algorithm.zeroInitSize) {
            const zeros = new Uint32Array(
                align(this.algorithm.zeroInitSize, 4) / 4);
            await this.target.writeBlock(
                this.codeBase + align(code.length, 4), zeros);
        }

        await this.target.writeMem32(this.returnAddress, BREAKPOINT_WORD);
        this.loaded = true;
    }

    /**
     * Call one of the algorithm's functions and wait for it to return.
     * @returns {Promise<number>} the value left in R0; 0 means success
     */
    async call(name, args = [], timeout) {
        const offset = this.algorithm.entries[name];
        if (offset === undefined) {
            throw new Error(`this algorithm does not provide ${name}`);
        }
        if (!this.loaded) await this.load();

        await this.target.halt();

        const registers = [
            [CORE_REG.R0, args[0] ?? 0],
            [CORE_REG.R1, args[1] ?? 0],
            [CORE_REG.R2, args[2] ?? 0],
            [CORE_REG.R3, args[3] ?? 0],
            // Read-write position independent code reaches its data through R9.
            [CORE_REG.R9, this.staticBase],
            [CORE_REG.SP, this.stackTop],
            // Thumb bit set, or returning here faults into ARM state.
            [CORE_REG.LR, this.returnAddress | 1],
            [CORE_REG.PC, (this.codeBase + offset) | 1],
            // xPSR with T set: a Cortex-M executing without it takes a fault.
            [CORE_REG.xPSR, 0x01000000],
        ];
        for (const [number, value] of registers) {
            await this.target.writeCoreRegister(number, value >>> 0);
        }

        // Interrupts are the thing that breaks this. The target is running its
        // own program, with its vector table in flash and its timers live; the
        // moment the core resumes, an interrupt fires, the core jumps into the
        // application's handler and never comes back to our breakpoint. The
        // algorithm appears to hang, and the flash is never touched.
        //
        // Two belts: PRIMASK stops configurable interrupts, and C_MASKINTS
        // stops the ones debug can mask. PRIMASK is the reliable one; not
        // every part honours C_MASKINTS the same way.
        try {
            await this.target.writeCoreRegister(CORE_REG.SPECIAL, SPECIAL.PRIMASK);
        } catch (error) {
            // Older probes may refuse the special register; C_MASKINTS alone
            // is still better than nothing.
        }

        // C_MASKINTS is only accepted while C_HALT is set, so set it first and
        // then release C_HALT while keeping the mask.
        const masked = DBGKEY | DHCSR.C_DEBUGEN | DHCSR.C_MASKINTS;
        await this.target.writeMem32(REG.DHCSR, masked | DHCSR.C_HALT);
        await this.target.writeMem32(REG.DHCSR, masked);

        await this._waitForReturn(name, timeout);

        return (await this.target.readCoreRegister(CORE_REG.R0)) >>> 0;
    }

    async _waitForReturn(name, timeout) {
        const limit = Math.max(
            this.options.minimumTimeout,
            (timeout ?? this.device.programTimeout) * this.options.timeoutFactor);
        const deadline = Date.now() + limit;

        while (Date.now() < deadline) {
            const status = (await this.target.readMem32(REG.DHCSR)) >>> 0;
            if (status & DHCSR.S_HALT) {
                const pc = (await this.target.readCoreRegister(CORE_REG.PC)) >>> 0;
                // Halting anywhere else means the routine went astray rather
                // than returned, and R0 would be meaningless.
                if ((pc & ~1) !== this.returnAddress) {
                    this._astray(name, pc);
                }
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        // Leave the core halted: a runaway algorithm must not keep writing.
        await this.target.halt();
        const pc = (await this.target.readCoreRegister(CORE_REG.PC)) >>> 0;
        if (!this._inAlgorithm(pc)) this._astray(name, pc, limit);
        throw new Error(`${name} did not return within ${limit} ms`);
    }

    /** Is this address inside the algorithm we loaded? */
    _inAlgorithm(address) {
        return address >= this.codeBase && address <= this.returnAddress;
    }

    /**
     * The core ended up somewhere it should not be. Say something useful:
     * landing outside the algorithm almost always means an interrupt took it.
     */
    _astray(name, pc, timeout) {
        // Whatever ran out there has been using the same RAM, so the loaded
        // algorithm can no longer be trusted.
        this.loaded = false;

        const where = `0x${pc.toString(16)}`;
        if (!this._inAlgorithm(pc)) {
            throw new Error(
                `${name} left the algorithm and stopped at ${where}, outside ` +
                `the RAM it was loaded into. An interrupt in the running ` +
                `program most likely took the core away. Check that ` +
                `interrupts are masked.`);
        }
        throw new Error(
            timeout
                ? `${name} did not return within ${timeout} ms, stuck at ${where}`
                : `${name} stopped at ${where} instead of returning: it faulted`);
    }

    /**
     * Undo the interrupt masking.
     *
     * Worth being careful about: leaving PRIMASK set or C_MASKINTS asserted
     * means the freshly written program runs with its interrupts dead, which
     * looks like flashing succeeded and the firmware is broken.
     */
    async release() {
        try {
            await this.target.writeCoreRegister(CORE_REG.SPECIAL, 0);
        } catch (error) {
            // Nothing to undo if it was never accepted.
        }
        const state = (await this.target.readMem32(REG.DHCSR)) >>> 0;
        await this.target.writeMem32(
            REG.DHCSR,
            DBGKEY | DHCSR.C_DEBUGEN | (state & DHCSR.S_HALT ? DHCSR.C_HALT : 0));
    }

    /** Check a return code and turn a failure into a readable error. */
    _check(name, result) {
        if (result !== 0) {
            throw new Error(`${name} failed with code 0x${result.toString(16)}`);
        }
        return result;
    }

    async init(address = this.device.address, operation = OPERATION.PROGRAM) {
        this._check('Init', await this.call(
            'Init', [address, this.options.clock, operation],
            this.device.eraseTimeout));
    }

    async uninit(operation = OPERATION.PROGRAM) {
        if (!('UnInit' in this.algorithm.entries)) return;
        this._check('UnInit', await this.call('UnInit', [operation]));
    }

    async eraseSector(address) {
        this._check(`EraseSector(0x${address.toString(16)})`, await this.call(
            'EraseSector', [address], this.device.eraseTimeout));
    }

    async eraseAll() {
        if (!('EraseChip' in this.algorithm.entries)) {
            throw new Error('this algorithm cannot erase the whole chip');
        }
        // Erasing everything takes far longer than erasing one sector.
        this._check('EraseChip', await this.call(
            'EraseChip', [], this.device.eraseTimeout * 64));
    }

    /**
     * Program one page. `data` is padded to the page size with the erased
     * value, since a partial page would otherwise write whatever was in RAM.
     */
    async programPage(address, data) {
        const page = new Uint8Array(this.device.pageSize);
        page.fill(this.device.valueEmpty);
        page.set(data.subarray(0, this.device.pageSize));

        await this.target.writeBlock(
            this.bufferAddress,
            new Uint32Array(page.buffer, page.byteOffset, page.length / 4));

        this._check(`ProgramPage(0x${address.toString(16)})`, await this.call(
            'ProgramPage', [address, page.length, this.bufferAddress],
            this.device.programTimeout));
    }

    /** The sectors a given range falls into, from the device descriptor. */
    sectorsFor(address, length) {
        const { sectors, address: base, size } = this.device;
        const list = [];

        for (let at = address; at < address + length;) {
            // Sector entries are sorted by start address and each one applies
            // until the next begins, so the last one at or below wins.
            let sectorSize = sectors[0]?.size;
            for (const sector of sectors) {
                if (base + sector.address <= at) sectorSize = sector.size;
            }
            if (!sectorSize) throw new Error('the descriptor declares no sectors');

            const start = at - ((at - base) % sectorSize);
            list.push({ address: start, size: sectorSize });
            at = start + sectorSize;
        }

        const end = base + size;
        if (list.some(s => s.address < base || s.address + s.size > end)) {
            throw new Error('the range falls outside the device\'s flash');
        }
        return list;
    }

    /**
     * Erase and write a firmware image.
     *
     * @param {number} address  Where to write, usually the start of flash
     * @param {Uint8Array} data  The image
     * @param {object} [options]
     * @param {(progress: {phase: string, done: number, total: number}) => void}
     *   [options.onProgress]
     * @param {boolean} [options.erase=true]
     */
    async program(address, data, options = {}) {
        const { onProgress = () => {}, erase = true } = options;
        const pageSize = this.device.pageSize;

        await this.load();

        if (erase) {
            const sectors = this.sectorsFor(address, data.length);
            // Init is told which operation is coming; some parts unlock
            // different hardware for erase than for program.
            await this.init(address, OPERATION.ERASE);
            let done = 0;
            for (const sector of sectors) {
                await this.eraseSector(sector.address);
                onProgress({ phase: 'erase', done: ++done, total: sectors.length });
            }
            await this.uninit(OPERATION.ERASE);
        }

        try {
            await this.init(address, OPERATION.PROGRAM);
            const pages = Math.ceil(data.length / pageSize);
            for (let i = 0; i < pages; i++) {
                const offset = i * pageSize;
                await this.programPage(
                    address + offset, data.subarray(offset, offset + pageSize));
                onProgress({ phase: 'program', done: i + 1, total: pages });
            }
            await this.uninit(OPERATION.PROGRAM);
        } finally {
            // Whether or not it worked, the chip must not be left with its
            // interrupts masked.
            await this.release().catch(() => {});
        }
    }

    /**
     * Read the flash back and compare. Independent of the algorithm's own
     * Verify, which not every vendor provides and which trusts the same code
     * that just did the writing.
     */
    async verify(address, data, options = {}) {
        const { onProgress = () => {} } = options;
        const chunk = 256;   // words per read, kept small for responsiveness
        const words = Math.ceil(data.length / 4);

        for (let at = 0; at < words; at += chunk) {
            const count = Math.min(chunk, words - at);
            const read = await this.target.readBlock(address + at * 4, count);

            for (let i = 0; i < count; i++) {
                const offset = (at + i) * 4;
                let expected = 0;
                for (let b = 0; b < 4; b++) {
                    const value = offset + b < data.length
                        ? data[offset + b] : this.device.valueEmpty;
                    expected |= value << (b * 8);
                }
                if ((read[i] >>> 0) !== (expected >>> 0)) {
                    throw new Error(
                        `verify failed at 0x${(address + offset).toString(16)}: ` +
                        `read 0x${(read[i] >>> 0).toString(16)}, ` +
                        `expected 0x${(expected >>> 0).toString(16)}`);
                }
            }
            onProgress({ phase: 'verify', done: at + count, total: words });
        }
    }
}
