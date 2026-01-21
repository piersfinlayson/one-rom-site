// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Unified device programmer supporting both Ice (STM32) and Fire (RP2350)
class UnifiedProgrammer {
    constructor() {
        this.deviceType = null;  // 'Ice' or 'Fire'
        this.dfuDevice = null;
        this.picobootDevice = null;
        this.cachedUsbDevice = null;
        this.progressInterval = null;
        
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
        let usbDevice;
        
        // If we have a cached device and not forcing picker, reuse it
        if (!forcePicker && this.cachedUsbDevice) {
            usbDevice = this.cachedUsbDevice;
        } else {
            // Show picker with both device types
            if (!('usb' in navigator)) {
                throw new Error('WebUSB not supported by this browser');
            }
            
            try {
                usbDevice = await navigator.usb.requestDevice({
                    filters: [
                        { vendorId: 0x0483, productId: 0xdf11 },  // STM32 DFU (Ice)
                        { vendorId: 0x2e8a, productId: 0x000f }   // RP2350 Picoboot (Fire)
                    ]
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
        if (usbDevice.vendorId === 0x2e8a && usbDevice.productId === 0x000f) {
            this.deviceType = 'Fire';
            this.picobootDevice = Picoboot.fromDevice(usbDevice);
            await this.picobootDevice.connect();
        } else if (usbDevice.vendorId === 0x0483 && usbDevice.productId === 0xdf11) {
            this.deviceType = 'Ice';
            this.dfuDevice = new usbDfuDevice();
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
                
                await this.picobootDevice.flashEraseAndWrite(
                    this.RP2350_FLASH_BASE, 
                    dataArray
                );
                
                dfuStatusHandler("Programming");
                // Progress continues automatically via interval
                
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