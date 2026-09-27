/**
 * WebHID transport for dapjs.
 *
 * dapjs ships transports for Node (node-hid, usb) and for WebUSB, but not for
 * WebHID. CMSIS-DAP v1 probes enumerate as HID devices, so today they cannot
 * be used from a browser at all. This is the missing piece.
 *
 * The wire protocol is simple — 64-byte reports in both directions, one per
 * command and one per response. The subtle part is that WebHID delivers
 * reports through events while dapjs expects to pull them with `read()`,
 * hence the queue in between.
 */

const REPORT_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 1000;

export class WebHIDTransport {
    /**
     * @param {HIDDevice} device  A device obtained from navigator.hid
     * @param {object} [options]
     * @param {number} [options.timeout=1000]  Milliseconds to wait for a reply
     */
    constructor(device, options = {}) {
        if (!device) throw new Error('a HIDDevice is required');
        this.device = device;
        this.packetSize = REPORT_SIZE;
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

        // Reports arrive as events but are consumed on demand: if one arrives
        // before anybody asks, park it; if somebody asks first, park the
        // promise instead.
        this._received = [];
        this._waiting = [];

        this._onReport = (event) => {
            const view = new DataView(
                event.data.buffer, event.data.byteOffset, event.data.byteLength);
            const pending = this._waiting.shift();
            if (pending) {
                clearTimeout(pending.timer);
                pending.resolve(view);
            } else {
                this._received.push(view);
            }
        };
    }

    async open() {
        if (!this.device.opened) await this.device.open();
        this.device.addEventListener('inputreport', this._onReport);
    }

    async close() {
        this.device.removeEventListener('inputreport', this._onReport);
        // Reject anything still waiting, or callers hang forever on close.
        for (const pending of this._waiting) {
            clearTimeout(pending.timer);
            pending.reject(new Error('transport closed'));
        }
        this._waiting = [];
        this._received = [];
        if (this.device.opened) await this.device.close();
    }

    /**
     * CMSIS-DAP v1 uses fixed-size reports: the buffer must be padded to the
     * full report size or the probe discards the command.
     */
    async write(data) {
        const source = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        const report = new Uint8Array(REPORT_SIZE);
        report.set(source.subarray(0, REPORT_SIZE));

        // Report ID 0: the convention for CMSIS-DAP over HID, which does not
        // number its reports.
        await this.device.sendReport(0, report);
    }

    /** @returns {Promise<DataView>} */
    read() {
        const queued = this._received.shift();
        if (queued) return Promise.resolve(queued);

        return new Promise((resolve, reject) => {
            const pending = { resolve, reject, timer: null };
            // Without a deadline, a command the probe does not understand
            // leaves the promise pending and looks like a hang.
            pending.timer = setTimeout(() => {
                const i = this._waiting.indexOf(pending);
                if (i !== -1) this._waiting.splice(i, 1);
                reject(new Error(`probe did not answer within ${this.timeout} ms`));
            }, this.timeout);
            this._waiting.push(pending);
        });
    }
}

/**
 * Vendor IDs of boards and probes known to expose CMSIS-DAP over HID.
 * Handy as a filter for navigator.hid.requestDevice().
 */
export const KNOWN_PROBES = [
    { vendorId: 0x2341 },  // Arduino (Uno R4 and others)
    { vendorId: 0x0d28 },  // NXP / mbed DAPLink
    { vendorId: 0x1366 },  // SEGGER
    { vendorId: 0x03eb },  // Atmel / Microchip
    { vendorId: 0x2e8a },  // Raspberry Pi (Picoprobe)
    { vendorId: 0x1209 },  // pid.codes, used by community probes
];

/**
 * Convenience wrapper: ask the user for a probe and return an open transport.
 * Must be called from a user gesture, as WebHID requires.
 */
export async function requestTransport(options = {}) {
    if (!('hid' in navigator)) {
        throw new Error('this browser does not support WebHID (try Chrome or Edge)');
    }
    const filters = options.filters ?? KNOWN_PROBES;
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices.length) throw new Error('no device selected');

    const transport = new WebHIDTransport(devices[0], options);
    await transport.open();
    return transport;
}

/** Transports for probes the page was already granted access to. */
export async function getTransports(options = {}) {
    if (!('hid' in navigator)) return [];
    const devices = await navigator.hid.getDevices();
    return devices.map(d => new WebHIDTransport(d, options));
}
