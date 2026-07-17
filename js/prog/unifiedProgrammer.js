// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Before changing connect(), reboot() or rebootAndReconnect(), read note 7 in
// the architectural notes at the top of programmer.js: device identity here is
// subtler than it looks, and getting it wrong puts a device picker in front of
// the user on every Stop and Run.

// Every VID/PID a One ROM can present as.
//
// The Fire PID encodes the run state - f540 stopped, f542 running - so it
// changes whenever the device reboots. Anything that looks the device up by the
// PID it was last seen with therefore cannot find it after a reboot, which is
// why reconnection matches against this list rather than the last-seen PID.
const ONEROM_USB_DEVICES = [
    { vendorId: 0x0483, productId: 0xdf11 },  // STM32 DFU (Ice)
    { vendorId: 0x2e8a, productId: 0x000f },  // RP2350 Picoboot (Fire)
    { vendorId: 0x1209, productId: 0xf540 },  // One ROM Fire Bootloader
    { vendorId: 0x1209, productId: 0xf542 }   // One ROM Fire
];

// How long to wait for a device to re-enumerate after a reboot before giving
// up. Re-enumeration is typically well under a second; this is generous.
const REBOOT_REENUMERATE_TIMEOUT_MS = 5000;

function isOneRomDevice(device) {
    return ONEROM_USB_DEVICES.some(known =>
        known.vendorId === device.vendorId && known.productId === device.productId);
}

// Unified device programmer supporting both Ice (STM32) and Fire (RP2350)
class UnifiedProgrammer {
    constructor() {
        this.deviceType = null;  // 'Ice' or 'Fire'
        this.dfuDevice = null;
        this.picobootDevice = null;
        this.cachedUsbDevice = null;
        this.progressInterval = null;
        this.runMode = false;
        
        // Speed estimates for RP2350 (bytes per second)
        this.RP2350_SPEEDS = {
            READ: 360 * 1024,    // 360 KB/s
            ERASE: 100 * 1024,   // 100 KB/s  
            WRITE: 240 * 1024    // 240 KB/s
        };
        
        // Flash parameters
        this.RP2350_FLASH_BASE = 0x10000000;
        this.RP2350_SECTOR_SIZE = 4096;
    }
    
    /**
     * Connect to a device
     * @param {boolean} forcePicker - Force device picker even if we have a cached device
     * @returns {Promise<void>}
     */
    async connect(forcePicker = false) {
        // Already connected, and not being asked to choose a device: there is
        // nothing to do. Without this, connecting again builds a second device
        // object on top of the first - which happens whenever a caller reattaches
        // and something downstream connects again to read the device back. The
        // only thing that drops a connection underneath us is reboot(), which
        // disconnects and clears deviceType, so this cannot mask a stale handle.
        if (this.isConnected() && !forcePicker) {
            return;
        }

        let usbDevice;
        
        // If we have a previously authorised device and aren't forcing the picker,
        // try to get a *fresh* handle via getDevices() rather than reusing the
        // stale cached object (which becomes invalid after a physical unplug/replug).
        if (!forcePicker && this.cachedUsbDevice) {
            // Look for any authorised One ROM rather than the exact PID we saw
            // last: a reboot changes the PID, so matching it would miss the very
            // device we just rebooted. getDevices() only ever returns devices
            // the user has already authorised for this origin, so this cannot
            // reach a device they have not approved.
            const devices = await navigator.usb.getDevices();

            // Prefer the same physical device where the serial identifies it, so
            // that having two One ROMs attached does not silently reconnect to
            // the wrong one. Not every mode reports a serial, so fall back to
            // any One ROM.
            const serial = this.cachedUsbDevice.serialNumber;
            const refreshed =
                (serial && devices.find(d => isOneRomDevice(d) && d.serialNumber === serial)) ||
                devices.find(isOneRomDevice);

            if (refreshed) {
                usbDevice = refreshed;
                this.cachedUsbDevice = refreshed;  // keep cache current
            } else {
                // Device was unplugged and not yet re-paired; clear cache and
                // fall through to the picker so the user can re-select it.
                this.cachedUsbDevice = null;
            }
        }

        if (!usbDevice) {
            // Show picker...
            try {
                usbDevice = await navigator.usb.requestDevice({
                    filters: ONEROM_USB_DEVICES
                });
                
                this.cachedUsbDevice = usbDevice;
            } catch (error) {
                if (error.name === 'NotFoundError') {
                    throw new Error('No device selected');
                }
                throw error;
            }
        }
        
        // Auto-detect device type from VID/PID
        if ((usbDevice.vendorId === 0x2e8a && usbDevice.productId === 0x000f) ||
            (usbDevice.vendorId === 0x1209 && usbDevice.productId === 0xf540) ||
            (usbDevice.vendorId === 0x1209 && usbDevice.productId === 0xf542)) {
            this.deviceType = 'Fire';
            this.runMode = (usbDevice.productId === 0xf542);
            this.picobootDevice = Picoboot.fromDevice(usbDevice);
            await this.picobootDevice.connect();
        } else if (usbDevice.vendorId === 0x0483 && usbDevice.productId === 0xdf11) {
            this.deviceType = 'Ice';
            this.dfuDevice = new usbDfuDevice();
            this.runMode = false;
            await this.dfuDevice.connectWithDevice(usbDevice);
        } else {
            throw new Error('Unknown device type');
        }
    }
    
    /**
     * Disconnect from the device
     * @returns {Promise<void>}
     */
    async disconnect() {
        // Clean up any active progress intervals
        this._stopProgressEstimation(0);
        
        if (this.deviceType === 'Fire') {
            if (this.picobootDevice) {
                await this.picobootDevice.disconnect();
                this.picobootDevice = null;
            }
        } else if (this.deviceType === 'Ice') {
            if (this.dfuDevice) {
                await this.dfuDevice.disconnect();
                this.dfuDevice = null;
            }
        }
        
        this.deviceType = null;
    }
    
    /**
     * Read firmware from device
     * @param {number} length - Number of bytes to read
     * @returns {Promise<Uint8Array>}
     */
    async upload(length) {
        if (!this.isConnected()) {
            await this.connect(false);  // false = use cached if available
        }
        
        if (this.deviceType === 'Fire') {
            const estimatedMs = (length / this.RP2350_SPEEDS.READ) * 1000;
            
            this._startProgressEstimation(estimatedMs);
            try {
                const data = await this.picobootDevice.flashRead(
                    this.RP2350_FLASH_BASE, 
                    length
                );
                this._stopProgressEstimation(100);
                return data;
            } catch (error) {
                this._stopProgressEstimation(0);
                throw error;
            }
        } else if (this.deviceType === 'Ice') {
            // Ice uses DFU's native progress reporting
            return await this.dfuDevice.upload(length);
        } else {
            throw new Error('No device connected');
        }
    }

    /**
     * Read `length` bytes from an absolute target address.
     *
     * Unlike upload(), which reads flash from the flash base, this reads from
     * an arbitrary address — the parser uses it to follow runtime pointers into
     * RAM (0x20000000+) on a running device. flashRead() accepts arbitrary
     * addresses, so the same picoboot command serves both flash and RAM.
     *
     * No progress estimation: these reads are small (a few hundred bytes) and
     * finish quickly, so a progress bar would only flicker.
     *
     * @param {number} addr - Absolute target address (e.g. 0x20000200)
     * @param {number} length - Number of bytes to read
     * @returns {Promise<Uint8Array>} Exactly `length` bytes at `addr`
     */
    async readMemory(addr, length) {
        if (!this.isConnected()) {
            await this.connect(false);  // false = use cached if available
        }

        if (this.deviceType === 'Fire') {
            // flashRead reads arbitrary addresses, RAM included.
            return await this.picobootDevice.flashRead(addr, length);
        } else if (this.deviceType === 'Ice') {
            // Ice only ever connects in STM32 DFU bootloader mode, so it is
            // never running and has no live runtime info to read. The parser
            // will not request RAM for an Ice device, so this should be
            // unreachable; throw rather than return bad data if it happens.
            throw new Error('readMemory is not supported on Ice devices');
        } else {
            throw new Error('No device connected');
        }
    }
    
    /**
     * Program firmware to device
     * @param {ArrayBuffer} fileArr - Firmware data to program
     * @param {string} mcuVariant - MCU variant (for validation)
     * @returns {Promise<void>}
     */
    async runUpdateSequence(fileArr, mcuVariant) {
        // Auto-connect if not already connected
        if (!this.isConnected()) {
            await this.connect(false);  // false = use cached if available
        }
        
        if (this.deviceType === 'Fire') {
            const dataLength = fileArr.byteLength;
            
            // Calculate erase size (round up to sector size)
            const eraseLength = Math.ceil(dataLength / this.RP2350_SECTOR_SIZE) * this.RP2350_SECTOR_SIZE;
            
            // Estimate total time: erase + write
            const eraseMs = (eraseLength / this.RP2350_SPEEDS.ERASE) * 1000;
            const writeMs = (dataLength / this.RP2350_SPEEDS.WRITE) * 1000;
            const totalMs = eraseMs + writeMs;
            
            this._startProgressEstimation(totalMs);
            
            try {
                dfuStatusHandler("Erasing");
                
                // Convert ArrayBuffer to Uint8Array if needed
                const dataArray = fileArr instanceof Uint8Array ? 
                    fileArr : new Uint8Array(fileArr);
                
                // Progress continues automatically via interval
                dfuStatusHandler("Programming");
                
                await this.picobootDevice.flashEraseAndWrite(
                    this.RP2350_FLASH_BASE, 
                    dataArray
                );
                
                this._stopProgressEstimation(100);
                dfuStatusHandler("Complete");
            } catch (error) {
                this._stopProgressEstimation(0);
                dfuStatusHandler("Error");
                throw error;
            }
        } else if (this.deviceType === 'Ice') {
            // Ice uses DFU's native progress and status handling
            return await this.dfuDevice.runUpdateSequence(fileArr, mcuVariant);
        } else {
            throw new Error('No device connected');
        }
    }

    /**
     * Check if device is in Run mode (application mode, f542)
     * @returns {boolean}
     */
    isRunMode() {
        return this.runMode;
    }

    /**
     * Reboot the device into stopped (bootloader) or running (application) mode
     * @param {boolean} stopped - true for stopped/bootloader, false for running/application
     * @returns {Promise<void>}
     */
    async reboot(stopped) {
        if (!this.isConnected()) {
            await this.connect(false);
        }
        if (this.deviceType !== 'Fire') {
            throw new Error('Reboot only supported on Fire devices');
        }
        if (stopped) {
            await this.picobootDevice.rebootRp2350(0x0002, 0x01, 0, 10);
        } else {
            await this.picobootDevice.rebootRp2350(0x0000, 0, 0, 10);
        }
        await this.disconnect();
    }
    
    /**
     * Reboot into stopped (bootloader) or running (application) mode, then
     * reconnect once the device has re-enumerated.
     *
     * reboot() leaves us disconnected, and the device reappears under a
     * different PID a short time later. Callers that need to keep working with
     * the device - programming a running One ROM, or restarting it afterwards -
     * need it back, silently: by the time a flash has finished there is no user
     * activation left, so a picker may not even be permitted to appear.
     *
     * The reconnect is silent provided the target mode's PID has been authorised
     * before. Returning to a mode we have already talked to (the usual case -
     * stop, program, run) always is. Entering a mode for the first time is not,
     * and returns false so the caller can decide whether to fall back to the
     * picker.
     *
     * @param {boolean} stopped - true for stopped/bootloader, false for running
     * @returns {Promise<boolean>} true if reconnected, false if the device did
     *          not reappear as an authorised device within the timeout
     */
    async rebootAndReconnect(stopped) {
        const previousPid = this.cachedUsbDevice ? this.cachedUsbDevice.productId : null;

        await this.reboot(stopped);

        const device = await this._waitForReenumeration(previousPid);
        if (!device) {
            return false;
        }

        this.cachedUsbDevice = device;
        await this.connect(false);
        return true;
    }

    /**
     * Wait for a One ROM to appear on the bus under a PID other than the one
     * given.
     *
     * The PID encodes the mode, so a reboot must change it. Requiring a change
     * also avoids latching onto the outgoing device in the moment between the
     * reboot command being accepted and the host noticing the detach.
     *
     * @private
     * @param {number|null} previousPid - PID before the reboot, if known
     * @returns {Promise<USBDevice|null>} the device, or null on timeout
     */
    async _waitForReenumeration(previousPid) {
        const deadline = Date.now() + REBOOT_REENUMERATE_TIMEOUT_MS;

        for (;;) {
            const devices = await navigator.usb.getDevices();
            const device = devices.find(d =>
                isOneRomDevice(d) && d.productId !== previousPid);
            if (device) {
                return device;
            }
            if (Date.now() >= deadline) {
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * Get device information
     * @returns {Object}
     */
    getDeviceInfo() {
        if (this.deviceType === 'Fire') {
            return this.picobootDevice.getUsbDeviceInfo();
        } else if (this.deviceType === 'Ice') {
            // Construct similar info structure for Ice
            const device = this.dfuDevice.device;
            return {
                vendorId: device.vendorId,
                productId: device.productId,
                productName: device.productName,
                manufacturerName: device.manufacturerName,
                serialNumber: device.serialNumber,
                deviceVersionMajor: device.deviceVersionMajor,
                deviceVersionMinor: device.deviceVersionMinor,
                deviceVersionSubminor: device.deviceVersionSubminor
            };
        } else {
            return null;
        }
    }
    
    /**
     * Get the detected device type
     * @returns {string|null} - 'Ice', 'Fire', or null
     */
    getDeviceType() {
        return this.deviceType;
    }
    
    /**
     * Check if a device is currently connected
     * @returns {boolean}
     */
    isConnected() {
        return this.deviceType !== null;
    }
    
    // Private methods for progress estimation
    
    /**
     * Start progress estimation for Fire operations
     * @private
     * @param {number} totalMs - Estimated total milliseconds for operation
     */
    _startProgressEstimation(totalMs) {
        let progressPercent = 1;
        dfuProgressHandler(progressPercent);
        
        const startTime = Date.now();
        this.progressInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            progressPercent = Math.min(95, Math.floor((elapsed / totalMs) * 100));
            dfuProgressHandler(progressPercent);
        }, 100);
    }
    
    /**
     * Stop progress estimation and set final value
     * @private
     * @param {number} finalPercent - Final progress percentage (0-100)
     */
    _stopProgressEstimation(finalPercent = 100) {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        dfuProgressHandler(finalPercent);
    }
}