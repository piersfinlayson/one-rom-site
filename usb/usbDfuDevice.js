// ISC License
// 
// Copyright 2022 Silicon Witchery AB
// 
// Permission to use, copy, modify, and/or distribute this software for any 
// purpose with or without fee is hereby granted, provided that the above 
// copyright notice and this permission notice appear in all copies.
// 
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH 
// REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY 
// AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, 
// INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM 
// LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR 
// OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR 
// PERFORMANCE OF THIS SOFTWARE.

// Changes to support One ROM USB Copyright 2025 Piers Finlayson
//
// MIT License

//  
//  
//      This file contains everything needed for implementing a basic USB 
//      firmware upgrade using Chrome to STM32 based devices. This is how to get 
//      started
//   
//      Firstly, include this file into your HTML <head> block:
//  
//          <script src="usbDfuDevice.js"></script>
//   
//      Then create an instance of the dfu object inside your <script> block. 
//  
//          let dfu = new usbDfuDevice();
//  
//      Once you have retrieved your update.bin file, call the function
//      runUpdateSequence() and pass the arrayBuffer containing your 
//      firmware. It doesn't seem straightforward to automatically get flash and 
//      page size within the bootloader. So you'll need to provide both these 
//      values too. They can be as strings (hex or dec format) or as a number.
//  
//          await dfu.runUpdateSequence(binaryData, flashSizeStr, pageSizeStr);
//  
//      A connection pane will appear, and any devices with the STM32 vendorID 
//      will be shown. Note the device must be in DFU mode. This is usually 
//      achieved by holding the BOOT pin during reset of the STM32. The update 
//      sequence function is asynchronous so the await keyword can be used. It 
//      returns a promise on completion.
//   
//      It's also possible to call the update steps manually. Look at the 
//      runUpdateSequence() function to see how this is done.
//
//      Further details on how the DFU sequence should work can be found within 
//      this application note:
//  
//          https://www.st.com/resource/en/application_note/cd00264379-usb-dfu-protocol-used-in-the-stm32-bootloader-stmicroelectronics.pdf
//  
//      The exact specification of the USB DFU protocol is documented here:
//  
//          https://www.usb.org/sites/default/files/DFU_1.1.pdf
//  
//      More details of the WebUSB API can be found here: 
//  
//          https://web.dev/usb/
//
//      To learn more about us, visit out website:
//
//          https://www.siliconwitchery.com


// Class constructor containing all the DFU functions and parameters 
let usbDfuDevice = class {

    // List of DFU requests we can perform. These are according to the DFU spec
    dfuRequest = {
        DFU_DETACH: 0x00,
        DFU_DNLOAD: 0x01,
        DFU_UPLOAD: 0x02,
        DFU_GETSTATUS: 0x03,
        DFU_CLRSTATUS: 0x04,
        DFU_GETSTATE: 0x05,
        DFU_ABORT: 0x06
    }

    // List of states the DFU state machine can be in. Also according to spec
    dfuState = {
        STATE_APP_IDLE: 0,
        STATE_APP_DETACH: 1,
        STATE_IDLE: 2,
        STATE_DNLOAD_SYNC: 3,
        STATE_DNBUSY: 4,
        STATE_DNLOAD_IDLE: 5,
        STATE_MANIFEST_SYNC: 6,
        STATE_MANIFEST: 7,
        STATE_MANIFEST_WAIT_RESET: 8,
        STATE_UPLOAD_IDLE: 9,
        STATE_ERROR: 10
    }

    // Finally, the list of error codes which can return. Again part of the spec
    dfuError = {
        OK: 0,
        ERROR_TARGET: 1,
        ERROR_FILE: 2,
        ERROR_WRITE: 3,
        ERROR_ERASE: 4,
        ERROR_CHECK_ERASED: 5,
        ERROR_PROG: 6,
        ERROR_VERIFY: 7,
        ERROR_ADDRESS: 8,
        ERROR_NOTDONE: 9,
        ERROR_FIRMWARE: 10,
        ERROR_VENDOR: 11,
        ERROR_USBR: 12,
        ERROR_POR: 13,
        ERROR_UNKNOWN: 14,
        ERROR_STALLEDPKT: 15
    }

    // When an new instance of the dfu object is created, this will be called
    constructor() {

        // Creates a null device object
        this.device = null;
    }

    // MCU flash size lookup table
    mcuVariants = {
        'F401RB': 0x20000,   // 128KB
        'F401RC': 0x40000,   // 256KB  
        'F401RE': 0x80000,   // 512KB
        'F405RG': 0x100000,  // 1024KB
        'F411RC': 0x40000,   // 256KB
        'F411RE': 0x80000,   // 512KB
        'F446RC': 0x40000,   // 256KB
        'F446RE': 0x80000    // 512KB
    }

    // Helper function to get the latest DFU status. Often required before new 
    // operations
    async getStatus() {

        // Attempt to get status
        try {

            // Get 6 bytes with the status command
            let result = await this.device.controlTransferIn({
                requestType: 'class',
                recipient: 'interface',
                request: this.dfuRequest.DFU_GETSTATUS,
                value: 0,
                index: 0
            }, 6);

            // Extract the error code byte
            let error = result.data.getUint8(0);

            // Extract state code byte
            let state = result.data.getUint8(4);

            // Extract the poll timeout value
            let pollTime = result.data.getUint8(1);

            // Print info in the debug console
            console.log("Status: " + Object.keys(dfu.dfuError)[error] +
                " in dfu state: " + Object.keys(dfu.dfuState)[state] +
                ", Waiting: " + pollTime + "ms");

            // Wait for the given poll time
            await new Promise(resolve => setTimeout(resolve, pollTime));

            // If there's an error, or the state machine enters the error state
            if (error != this.dfuError.OK ||
                state == this.dfuState.STATE_ERROR) {

                // Return the error info
                throw ("Error: " + Object.keys(dfu.dfuError)[error] +
                    " in dfu state: " + Object.keys(dfu.dfuState)[state]);

                // This could be extended to return the error and state in a 
                // more machine readable way for retrying operations. Here we
                // just return an error string
            }

            // Otherwise if everything is ok, return the new state
            return Promise.resolve(state);
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }

    }

    // Helper function which clears any pending status in the DFU engine
    async clearStatus() {

        // Attempt to clear the status registers
        try {

            // Issue the status clear command
            let result = await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: this.dfuRequest.DFU_CLRSTATUS,
                value: 0,
                index: 0
            }, undefined)

            // If we stall
            if (result.status != 'ok') {

                // Throw a rejection
                throw ("Error: Couldn't clear status");
            }
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Sets the internal variables based on the selected MCU
    async setFlashSize(mcuType) {

        // Attempt to set the flash size based on MCU
        try {

            // Check if the MCU type is valid
            if (!this.mcuVariants[mcuType]) {
                throw ("Error: Unknown MCU type: " + mcuType);
            }

            // Get the flash size for this MCU
            let flashSize = this.mcuVariants[mcuType];

            // Set the flash end as an offset from 0x08000000
            this.flashEnd = 0x08000000 + flashSize;

            // Print info to the console
            console.log("MCU: " + mcuType + ", Flash size: " + flashSize / 1024 + " KB");
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Function to connect, returning status as promise
    async connect() {

        // First ensure WebUSB is available
        if (!navigator.usb) {
            return Promise.reject("Web USB not available. Are you using Chrome?");
        }

        // Attempt to connect
        try {

            // Request the device, filtering by ST-Micro's vendor ID
            this.device = await navigator.usb.requestDevice({
                filters: [{
                    vendorId: 0x0483
                }]
            });

            // Open the device
            await this.device.open();

            // Select configuration
            await this.device.selectConfiguration(1);

            // Claim interface
            await this.device.claimInterface(0);

            // Print some info to the console
            console.log("Connected to device. Serial number: " +
                this.device.serialNumber);

            // Clear the current state. Needed after first connection or errors
            await this.clearStatus();

            // Done and return
            return Promise.resolve();
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Helper function to get STM32F4 sector size based on address
    getSectorSize(address) {
        if (address < 0x08010000) {
            return 0x4000;      // Sectors 0-3: 16KB each
        } else if (address < 0x08020000) {
            return 0x10000;     // Sector 4: 64KB  
        } else {
            return 0x20000;     // Sectors 5+: 128KB each
        }
    }

    // Function which erases the device
    async erase(fileSize) {

        // Clear the progress bar
        dfuProgressHandler(0);

        // Attempt to erase
        try {

            // Calculate end address needed for file size
            let requiredEnd = 0x08000000 + fileSize;

            // Round up to next sector boundary  
            let currentSector = 0x08000000;
            while (currentSector < requiredEnd) {
                currentSector += this.getSectorSize(currentSector);
            }
            requiredEnd = currentSector;

            console.log("File size: " + fileSize + " bytes (" + (fileSize/1024).toFixed(1) + " KB)");
            console.log("Required end address: 0x" + requiredEnd.toString(16).toUpperCase());
            console.log("Flash end address: 0x" + this.flashEnd.toString(16).toUpperCase());
            console.log("Will erase from 0x08000000 to 0x" + Math.min(requiredEnd, this.flashEnd).toString(16).toUpperCase());

            // Only erase required sectors
            for (let address = 0x8000000; address < Math.min(requiredEnd, this.flashEnd); address += this.getSectorSize(address)) {

                let sectorSize = this.getSectorSize(address);

                // Print the erase operation to the console
                console.log("Erasing " + sectorSize + " bytes at 0x0" +
                    address.toString(16).toUpperCase());

                // Array containing the erase command and address to erase (LSB first)
                let arr = new Uint8Array([
                    0x41,
                    (address & 0x000000ff),
                    (address & 0x0000ff00) >> 8,
                    (address & 0x00ff0000) >> 16,
                    (address & 0xff000000) >> 24
                ]);

                // Perform the erase
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: this.dfuRequest.DFU_DNLOAD,
                    value: 0, // wValue Should be 0 for command mode
                    index: 0
                }, arr); // Holds the erase instruction and address location

                // Issue a get status to apply the operation
                await this.getStatus();

                // Check again if it was successful
                await this.getStatus();

                // Work out the percentage done
                let done = (100 / (requiredEnd - 0x8000000)) * (address - 0x8000000);
                
                // Update the progress bar
                dfuProgressHandler(done);
            }
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Function to program the device
    async program(fileArr) {

        // Clear the progress bar
        dfuProgressHandler(0);

        // Attempt to program
        try {

            // Set the address pointer to 0x08000000 (The start of the flash)
            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: this.dfuRequest.DFU_DNLOAD,
                value: 0, // wValue Should be 0 for command mode
                index: 0
            }, new Uint8Array([0x21, 0x00, 0x00, 0x00, 0x08]));

            // Issue a get status to apply the operation
            await this.getStatus();

            // Check again if it was successful
            await this.getStatus();

            // Calculate the total blocks to flash. A block can be up to 2048 bytes
            let totalBlocks = Math.ceil(fileArr.byteLength / 2048);

            // If the the total blocks is bigger than the flash size, throw an error
            if ((totalBlocks * 2048) > (this.flashEnd - 0x08000000)) {
                throw ("Error: File size is bigger than flash size");
            }

            // For every block
            for (let block = 0; block < totalBlocks; block++) {

                // Log the current block info to the console
                console.log("Programming block " + (block + 1) + " of " + totalBlocks);

                // Calculate the data offset and bounds based on the current block
                let dataStart = block * 2048;
                let dataEnd = dataStart + 2048;

                // Create 2048 sized data buffer to send
                let blockData = new Uint8Array(2048);

                // Copy data from the file to the dat buffer
                blockData.set(new Uint8Array(fileArr.slice(dataStart, dataEnd)));

                // Write block by block 
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: this.dfuRequest.DFU_DNLOAD,
                    value: 2 + block, // wValue should be the block number + 2 
                    index: 0
                }, blockData); // 2048 byte block of data to program

                // Issue a get status to apply the operation
                await this.getStatus();

                // Check again if it was successful
                await this.getStatus();

                // Work out the percentage done
                let done = (100 / totalBlocks) * block;

                // Update the progress bar
                dfuProgressHandler(done);
            }

            // Done. Set the progress bar to 100%
            dfuProgressHandler(100);
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Sequence to exit DFU mode, and start the application
    async detach() {

        // Attempt to detach
        try {

            // Log info to console
            console.log("Starting application");

            // Next download 0 bytes to the device
            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: this.dfuRequest.DFU_DNLOAD,
                value: 0, // Write 0 bytes
                index: 0
            }, undefined)

            // Finally read the status to trigger a reset
            await this.getStatus();
        }

        // Catch errors
        catch (error) {

            // Return the error
            return Promise.reject(error);
        }
    }

    // Function which disconnects the USB device
    async disconnect() {

        // If the device objects exists
        if (this.device != null) {

            // and the device is still open
            if (this.device.opened) {

                // Close the USB device
                await this.device.close();
            }
        }

        // Null the device object
        this.device = null;

        // Call the user disconnect handler to clean up the UI
        dfuDisconnectHandler();
    }

    // Executes the full DFU sequence. 
    async runUpdateSequence(fileArr, mcuType) {

        // Attempt the sequence
        try {

            // Set flash and page size
            await this.setFlashSize(mcuType);

            // Update the state
            dfuStatusHandler("Connecting");

            // Connect
            await this.connect();

            // Update the state
            dfuStatusHandler("Erasing");

            // Erase the chip
            await this.erase(fileArr.byteLength);

            // Update the state
            dfuStatusHandler("Programming");

            // Program the chip with the binary array
            await this.program(fileArr);

            // Update the state
            dfuStatusHandler("Done");

            // Detach the device
            await this.detach();

            // Update the state
            dfuStatusHandler("Disconnecting");

            // Disconnect
            await this.disconnect();

            // Return success
            return Promise.resolve("Update Complete");
        }

        // Catch errors
        catch (error) {

            // Always disconnect on error
            this.disconnect();

            // Return the error
            return Promise.reject(error);
        }
    }
}