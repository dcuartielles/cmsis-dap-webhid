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
 * Cortex-M debug helpers on top of dapjs.
 *
 * dapjs gives you halt, resume and memory access, but three things are missing
 * that you need almost immediately: single stepping, a readable view of the
 * debug state, and a way to recover from a failed transfer.
 *
 * All of this is verified against real hardware (Renesas RA4M1, Cortex-M4).
 */

/** Cortex-M debug registers. Same addresses across the family. */
export const REG = {
    DHCSR: 0xE000EDF0,   // debug halting control and status
    DCRSR: 0xE000EDF4,   // core register selector
    DCRDR: 0xE000EDF8,   // core register data
    DEMCR: 0xE000EDFC,   // debug exception and monitor control
    CPUID: 0xE000ED00,   // CPU identification
    AIRCR: 0xE000ED0C,   // application interrupt and reset control
};

/** DHCSR only accepts writes carrying this key in its upper half. */
const DBGKEY = 0xA05F0000;

export const DHCSR = {
    C_DEBUGEN:  1 << 0,
    C_HALT:     1 << 1,
    C_STEP:     1 << 2,
    C_MASKINTS: 1 << 3,
    S_REGRDY:   1 << 16,
    S_HALT:     1 << 17,
    S_SLEEP:    1 << 18,
    S_LOCKUP:   1 << 19,
};

/** Core register numbers, as used by readCoreRegister. */
export const CORE_REG = {
    R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7,
    R8: 8, R9: 9, R10: 10, R11: 11, R12: 12,
    SP: 13, LR: 14, PC: 15, xPSR: 16,
    MSP: 17, PSP: 18,
    // One register number covers four byte-wide ones, packed low to high:
    // PRIMASK, BASEPRI, FAULTMASK, CONTROL. Writing 1 sets PRIMASK and
    // clears the rest, which is privileged mode on the main stack.
    SPECIAL: 20,
};

/** Fields inside CORE_REG.SPECIAL. */
export const SPECIAL = {
    PRIMASK:   0x00000001,
    BASEPRI:   0x0000ff00,
    FAULTMASK: 0x00010000,
    CONTROL:   0x01000000,
};

/** Known Cortex-M part numbers, from the CPUID register. */
const CORES = {
    0xc20: 'Cortex-M0', 0xc60: 'Cortex-M0+', 0xc21: 'Cortex-M1',
    0xc23: 'Cortex-M3', 0xc24: 'Cortex-M4', 0xc27: 'Cortex-M7',
    0xd20: 'Cortex-M23', 0xd21: 'Cortex-M33',
};

/**
 * Execute a single instruction and wait for the core to halt again.
 * dapjs does not expose this; it is done by writing C_STEP to DHCSR.
 *
 * @returns {Promise<boolean>} false if the core kept running, which usually
 *   means it entered a wait or an interrupt handler.
 */
export async function step(target, { timeout = 100 } = {}) {
    await target.writeMem32(REG.DHCSR, DBGKEY | DHCSR.C_DEBUGEN | DHCSR.C_STEP);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = (await target.readMem32(REG.DHCSR)) >>> 0;
        if (value & DHCSR.S_HALT) return true;
        await new Promise(r => setTimeout(r, 2));
    }
    return false;
}

/**
 * Step several times, returning the program counter at each stop.
 * Useful to see where execution actually goes.
 */
export async function trace(target, count = 10) {
    const path = [];
    for (let i = 0; i < count; i++) {
        path.push((await target.readCoreRegister(CORE_REG.PC)) >>> 0);
        if (!await step(target)) break;
    }
    return path;
}

/** Debug state in readable terms. */
export async function state(target) {
    const value = (await target.readMem32(REG.DHCSR)) >>> 0;
    return {
        value,
        debugEnabled: !!(value & DHCSR.C_DEBUGEN),
        halted:       !!(value & DHCSR.S_HALT),
        sleeping:     !!(value & DHCSR.S_SLEEP),
        lockedUp:     !!(value & DHCSR.S_LOCKUP),
    };
}

/**
 * Clear a sticky transfer error.
 *
 * Reading an invalid address returns a FAULT and **leaves the DAP stuck**:
 * every later access fails until the error is cleared through the ABORT
 * register. Without this, a single bad read forces a page reload.
 */
export async function clearError(target) {
    // STKCMPCLR | STKERRCLR | WDERRCLR | ORUNERRCLR
    await target.writeDP(0x0, 0x1e);
}

/**
 * Read a word, returning null instead of breaking the link when the address
 * is not mapped.
 */
export async function readSafe(target, address) {
    try {
        return (await target.readMem32(address)) >>> 0;
    } catch (error) {
        if (/FAULT/i.test(error.message)) {
            await clearError(target);
            return null;
        }
        throw error;
    }
}

/** Snapshot of the core registers. Requires the core to be halted. */
export async function registers(target) {
    const out = {};
    for (const [name, number] of Object.entries(CORE_REG)) {
        out[name] = (await target.readCoreRegister(number)) >>> 0;
    }
    return out;
}

/** Identify the core from its CPUID register. */
export async function identify(target) {
    const cpuid = (await target.readMem32(REG.CPUID)) >>> 0;
    const partNumber = (cpuid >> 4) & 0xfff;
    return {
        cpuid,
        partNumber,
        core: CORES[partNumber] ?? `unknown (part 0x${partNumber.toString(16)})`,
        revision: (cpuid >> 20) & 0xf,
        patch: cpuid & 0xf,
    };
}

/**
 * Probe a list of addresses to find out where memory actually is.
 *
 * Worth doing: addresses taken from generic OpenOCD configurations are not
 * always valid. On the RA4M1, `0x1ffe0000` is listed as a work area and
 * faults; the usable RAM starts at `0x20000000`.
 */
export async function probeMemory(target, addresses) {
    const map = {};
    for (const address of addresses) {
        map[hex(address)] = await readSafe(target, address);
    }
    return map;
}

/** Format a value as a fixed-width hexadecimal string. */
export const hex = (value, digits = 8) =>
    '0x' + (value >>> 0).toString(16).padStart(digits, '0');
