/*
 * cmsis-dap-webhid — use CMSIS-DAP probes from the browser over WebHID
 * Copyright (C) 2026
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
 * cmsis-dap-webhid
 *
 * Talk to CMSIS-DAP probes from the browser over WebHID, and debug Cortex-M
 * targets with dapjs.
 */

export {
    WebHIDTransport,
    KNOWN_PROBES,
    requestTransport,
    getTransports,
} from './transport.js';

export {
    REG,
    DHCSR,
    CORE_REG,
    step,
    trace,
    state,
    clearError,
    readSafe,
    registers,
    identify,
    probeMemory,
    hex,
} from './debug.js';
