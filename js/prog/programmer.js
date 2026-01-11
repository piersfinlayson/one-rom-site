// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Create a USB dfu device object
let dfu = new usbDfuDevice();

// Initialize WASM
let wasmInitialized = false;
let parse_firmware;

(async function() {
    const wasm = await import('https://wasm.onerom.org/releases/v0.1.8/pkg/onerom_wasm.js');
    await wasm.default();
    parse_firmware = wasm.parse_firmware;
    wasmInitialized = true;
})();

// MCU variant mapping to firmware values.
// The numerical values match the enums in config_base.h.  They are used
// to verify the selected MCU matches the firmware being programmed.
const mcuVariantMap = {
    'F401RB': { line: 0x0004, storage: 0x01 },  // F401BC + B
    'F401RC': { line: 0x0004, storage: 0x02 },  // F401BC + C
    'F401RE': { line: 0x0000, storage: 0x04 },  // F401DE + E
    'F405RG': { line: 0x0001, storage: 0x06 },  // F405 + G
    'F411RC': { line: 0x0002, storage: 0x02 },  // F411 + C
    'F411RE': { line: 0x0002, storage: 0x04 },  // F411 + E
    'F446RC': { line: 0x0003, storage: 0x02 },  // F446 + C
    'F446RE': { line: 0x0003, storage: 0x04 }   // F446 + E
};

// Storage size mapping (in bytes)
const storageSizeMap = {
    'StorageB': 128 * 1024,
    'StorageC': 256 * 1024,
    'StorageE': 512 * 1024,
    'StorageG': 1024 * 1024
};

// Reverse lookup: convert firmware MCU values to variant name
function getMcuVariantName(line, storage) {
    for (const [variant, values] of Object.entries(mcuVariantMap)) {
        if (values.line === line && values.storage === storage) {
            return variant;
        }
    }
    return "Unknown (line=0x" + line.toString(16) + " storage=0x" + storage.toString(16) + ")";
}

function getMcuVariantFromStrings(line, storage) {
    const storageLetter = storage.replace('Storage', '');
    return line + 'R' + storageLetter;
}

// Reference to the text boxes, button and progress bar
const mcuSelectBox = document.getElementById('mcuSelectBox');
const pageSizeBox = document.getElementById('pageSizeBox');
const connectProgramButton = document.getElementById('connectProgramButton');
const progressBar = document.getElementById('progressBar');
const connectProgressBar = document.getElementById('connectProgressBar');

// Get references to tab elements
const tabButtons = document.querySelectorAll('.tab-button');
const tabInputs = document.querySelectorAll('.tab-input');

// When the button is clicked
connectProgramButton.addEventListener('click', function () {

    // Start the update function (This is an async process)
    startUpdate();
});

// Validate firmware binary
function validateFirmware(fileArr, mcuVariant) {
    const view = new Uint8Array(fileArr);
    const infoStructBase = 0x200;
    
    // Check for SDRR signature at offset 0x200
    const expectedSignature = [0x53, 0x44, 0x52, 0x52]; // "SDRR" in ASCII
    
    if (fileArr.byteLength < infoStructBase + expectedSignature.length) {
        throw ("Error: Invalid One ROM .bin file (Firmware file too small - expected \"SDRR\" signature at offset 0x200)");
    }
    
    for (let i = 0; i < expectedSignature.length; i++) {
        if (view[infoStructBase + i] !== expectedSignature[i]) {
            throw ("Error: Invalid One ROM .bin file (missing \"SDRR\" signature at offset 0x200)");
        }
    }
    
    // Check MCU line and storage match selected variant
    const mcuLineOffset = infoStructBase + 0x1C;
    const mcuStorageOffset = infoStructBase + 0x1E;
    
    const mcuLine = view[mcuLineOffset] | (view[mcuLineOffset + 1] << 8);
    const mcuStorage = view[mcuStorageOffset] | (view[mcuStorageOffset + 1] << 8);
    
    const expectedMcu = mcuVariantMap[mcuVariant];
    if (!expectedMcu) {
        throw ("Error: Unknown STM32 variant selected");
    }
    
    if (mcuLine !== expectedMcu.line || mcuStorage !== expectedMcu.storage) {
        const actualMcu = getMcuVariantName(mcuLine, mcuStorage);
        throw ("Error: One ROM firmware is for wrong STM32 variant (Firmware is for " + 
                actualMcu + ", expected " + mcuVariant + ")");
    }
    
    // Check USB DFU support flag in extra_info block
    const pointerOffset = infoStructBase + 0x38;
    const flashBase = 0x08000000;
    
    // Read pointer (little-endian)
    if (fileArr.byteLength < pointerOffset + 4) {
        throw ("Error: Invalid One ROM .bin file (Firmware file too small - cannot read extra_info pointer)");
    }
    
    const pointer = view[pointerOffset] | 
                    (view[pointerOffset + 1] << 8) | 
                    (view[pointerOffset + 2] << 16) | 
                    (view[pointerOffset + 3] << 24);
    
    // Convert flash address to file offset
    const extraInfoOffset = pointer - flashBase;
    
    if (extraInfoOffset < 0 || extraInfoOffset + 5 > fileArr.byteLength) {
        throw ("Error: Invalid One ROM .bin file (Invalid extra_info pointer in firmware 0x" + pointer.toString(16) + ")");
    }
    
    // Check USB DFU support flag at extra_info + 4
    const usbDfuSupport = view[extraInfoOffset + 4];
    
    if (usbDfuSupport !== 1) {
        throw ("Error: One ROM firmware provided does not support USB (Choose a firmware image that supports USB)");
    }
    
    return true;
}

// This function runs the update process. It is asynchronous because the operations inside take some time
async function startUpdate() {

    // Disable the button to avoid the user calling this multiple times
    connectProgramButton.disabled = true;
    connectBtn.disabled = true;

    // Hide detected device info
    document.getElementById('deviceSummary').classList.add('hidden');
    document.getElementById('deviceDetails').classList.add('hidden');

    // Try to get the file and run the update sequence
    try {

        // Variables to hold the firmware data and MCU variant
        let fileArr;
        let mcuVariant;
        
        // Determine which tab is currently active
        const activeTab = document.querySelector('.tab-button.active').getAttribute('data-tab');

        dfuStatusHandler("Retrieving");
        
        if (activeTab === 'url') {
            // URL tab: Download firmware from provided URL
            
            // Check MCU variant is selected
            mcuVariant = document.getElementById('mcuSelectUrl').value;
            if (mcuVariant == "") {
                throw ("Error: No STM32 variant selected");
            }

            // Check URL is provided
            if (fileLocationBox.value == "") {
                throw ("Error: No URL provided");
            }

            // Fetch the firmware file from the URL
            let response = await fetch(fileLocationBox.value);

            // Check for HTTP errors
            if (!response.ok) {
                if (response.status === 404) {
                    throw ("Error: Firmware file not found at the specified URL");
                } else if (response.status === 403) {
                    throw ("Error: Access denied to firmware file");
                } else {
                    throw ("Error: Failed to download firmware file (" + response.status + " " + response.statusText + ")");
                }
            }

            // Get the firmware data as an array buffer
            fileArr = await response.arrayBuffer();
            
        } else if (activeTab === 'file') {
            // Local File tab: Read firmware from uploaded file
            
            // Check MCU variant is selected
            mcuVariant = document.getElementById('mcuSelectFile').value;
            if (mcuVariant == "") {
                throw ("Error: No STM32 variant selected");
            }
            
            // Check a file has been selected
            if (!fileUploadBox.files || fileUploadBox.files.length === 0) {
                throw ("Error: No file selected");
            }
            
            // Read the file data
            const file = fileUploadBox.files[0];
            fileArr = await file.arrayBuffer();
            
        } else if (activeTab === 'prebuilt') {
            // Pre-built Images tab: Download firmware from GitHub release
            
            // Check that a firmware has been selected through the dropdowns
            if (!PrebuiltManager.selectedArtifact) {
                throw ("Error: No firmware selected");
            }
            
            // Download the firmware and verify its SHA256 checksum
            fileArr = await PrebuiltManager.downloadAndVerify();
            
            // Convert MCU format from manifest (lowercase like "f446rc") to validation format (uppercase like "F446RC")
            mcuVariant = PrebuiltManager.selectedArtifact.mcu.toUpperCase();
            
        } else {
            throw ("Error: No firmware source provided");
        }

        // Validate firmware before flashing
        validateFirmware(fileArr, mcuVariant);
        
        // Run the update sequence (existing code)
        await dfu.runUpdateSequence(fileArr, mcuVariant);

        // Automatically reconnect and refresh device info
        try {
            await dfu.connect(); // Use cached device, no picker
            await readAndDisplayDeviceInfo();
            await dfu.disconnect();

            // Update Connect button to Reconnect
            document.getElementById('connectBtn').textContent = 'Reconnect';

        } catch (error) {
            console.log("Failed to auto-refresh device info: " + error);

            setTimeout(() => alert("One ROM USB Programming completed, but failed to read back device info"), 100);
        }

    }

    // On any caught errors
    catch (error) {

        // User cancelled device selection - not an error
        if (error.name === 'NotFoundError' || 
            (error.message && error.message.includes('No device selected'))) {
            dfuDisconnectHandler();
            return;
        }

        // Reset the button and progress bar
        dfuDisconnectHandler();

        // Show the error as an alert
        alert(error);
    }

    finally {
        connectProgramButton.disabled = false;
        connectBtn.disabled = false;
    }
}

// Updates the button text. "Connecting", "Erasing", etc.
function dfuStatusHandler(status) {
    connectProgramButton.innerHTML = status;
}

// Updates the progress bar value. 0 - 100%
function dfuProgressHandler(value) {
    progressBar.value = value;
}

// This function is called on a disconnect event
function dfuDisconnectHandler() {

    // Reset the button back to 'connect'
    connectProgramButton.innerHTML = "Program";

    // Enable the button again
    connectProgramButton.disabled = false;

    // Reset the progress bar
    progressBar.value = 0;
}

// Build GitHub issue URL with template
(function() {
    const title = "One ROM USB Site Issue - Brief Description Here";
    const body = `## Environment

**Browser and Version:** 
**Operating System:** 
**STM32 Variant:** 

## Issue Description

<!-- Please describe the problem you encountered -->

## Steps to Reproduce

1. 
2. 
3. 

## Error Messages

<!-- If applicable, please paste any error messages here -->

## Firmware

Please upload your firmware .bin file if possible.

## Additional Context

<!-- Any other relevant information -->`;

    const url = `https://github.com/piersfinlayson/one-rom/issues/new?` +
                `title=${encodeURIComponent(title)}&` +
                `body=${encodeURIComponent(body)}`;
    
    document.getElementById('githubIssueLink').href = url;
    document.getElementById('githubIssueLink1').href = url;
    document.getElementById('githubIssueLink2').href = url;
    document.getElementById('githubIssueLink3').href = url;
})();

// Pre-built images functionality
const PrebuiltManager = {
    manifests: [],
    filteredArtifacts: [],
    selectedArtifact: null,
    
    async init() {
        try {
            // Check if CORS proxy is available
            try {
                const healthCheck = await fetch('https://github-cors.piers.rocks/health', {
                    method: 'GET',
                    cache: 'no-store'
                });
                if (!healthCheck.ok) {
                    throw new Error('Health check failed');
                }
            } catch (proxyError) {
                document.getElementById('prebuiltLoading').innerHTML = 
                    '<p><strong>Temporarily Unavailable</strong></p>' +
                    '<p>Pre-built images cannot be downloaded as the server is down. Try the Local Image or URL Image options instead, or come back later.</p><br/>';
                return;
            }

            // Fetch releases list from your repo
            const response = await fetch('https://raw.githubusercontent.com/piersfinlayson/one-rom/main/releases/releases.json');
            if (!response.ok) throw new Error('Failed to fetch releases list');
            
            const releases = await response.json();
            
            // Load manifests from latest to oldest (reverse order since we append to the list)
            for (const release of releases.reverse()) {
                try {
                    // Fetch the manifest for this release
                    const manifestUrl = `https://raw.githubusercontent.com/piersfinlayson/one-rom/main/releases/manifest-${release.tag}.json`;
                    const manifestResponse = await fetch(manifestUrl);
                    
                    if (manifestResponse.ok) {
                        const manifest = await manifestResponse.json();
                        this.manifests.push(manifest);
                        
                        // Update UI after first manifest loads
                        if (this.manifests.length === 1) {
                            this.showSelectors();
                            this.populateModels();
                        } else {
                            this.updateSelectors();
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (this.manifests.length === 0) {
                document.getElementById('prebuiltLoading').textContent = 'No pre-built images available';
            } else {
                // Auto-select ice model and trigger cascade
                const modelSelect = document.getElementById('modelSelect');
                modelSelect.value = 'ice';
                modelSelect.style.display = 'none';
                this.filterByModel('ice');
            }
        } catch (error) {
            document.getElementById('prebuiltLoading').textContent = 'Error loading releases: ' + error.message;
        }
    },
    
    showSelectors() {
        document.getElementById('prebuiltLoading').style.display = 'none';
        document.getElementById('prebuiltSelectors').style.display = 'flex';
    },
    
    populateModels() {
        const modelSelect = document.getElementById('modelSelect');
        const models = new Set();
        
        this.manifests.forEach(manifest => {
            Object.keys(manifest.models || {}).forEach(model => models.add(model));
        });
        
        models.forEach(model => {
            const manifest = this.manifests.find(m => m.models[model]);
            const option = document.createElement('option');
            option.value = model;
            option.textContent = manifest.models[model].display;
            modelSelect.appendChild(option);
        });
    },
    
    updateSelectors() {
        // Re-filter based on current selections
        const model = document.getElementById('modelSelect').value;
        if (model) {
            this.filterByModel(model);
        }
    },
    
    filterByModel(model) {
        const hwRevSelect = document.getElementById('hwRevSelect');
        hwRevSelect.innerHTML = '<option value="">Select ...</option>';
        hwRevSelect.disabled = false;
        
        const hwRevs = new Set();
        this.manifests.forEach(manifest => {
            manifest.artifacts.forEach(artifact => {
                if (artifact.model === model) {
                    // Only include hw_revs with USB support
                    if (manifest.hardware[artifact.hw_rev] && manifest.hardware[artifact.hw_rev].usb_support === true) {
                        hwRevs.add(artifact.hw_rev);
                    }
                }
            });
        });
        
        hwRevs.forEach(hwRev => {
            const manifest = this.manifests.find(m => m.hardware[hwRev]);
            if (manifest) {
                const option = document.createElement('option');
                option.value = hwRev;
                option.textContent = manifest.hardware[hwRev].display;
                hwRevSelect.appendChild(option);
            }
        });
        
        // Reset downstream selectors
        this.resetSelector('mcuSelectPrebuilt');
        this.resetSelector('versionSelect');
        this.resetSelector('romConfigSelect');
        document.getElementById('configDescription').classList.remove('visible');
    },
    
    filterByHwRev(model, hwRev) {
        const mcuSelect = document.getElementById('mcuSelectPrebuilt');
        mcuSelect.innerHTML = '<option value="">Select...</option>';
        mcuSelect.disabled = false;
        
        const mcus = new Set();
        this.manifests.forEach(manifest => {
            manifest.artifacts.forEach(artifact => {
                if (artifact.model === model && artifact.hw_rev === hwRev) {
                    mcus.add(artifact.mcu);
                }
            });
        });
        
        Array.from(mcus).sort().forEach(mcu => {
            const option = document.createElement('option');
            option.value = mcu;
            option.textContent = mcu.toUpperCase();
            mcuSelect.appendChild(option);
        });
        
        this.resetSelector('versionSelect');
        this.resetSelector('romConfigSelect');
        document.getElementById('configDescription').classList.remove('visible');
    },
    
    filterByMcu(model, hwRev, mcu) {
        const versionSelect = document.getElementById('versionSelect');
        versionSelect.innerHTML = '<option value="">Select...</option>';
        versionSelect.disabled = false;
        
        const versions = new Set();
        this.manifests.forEach(manifest => {
            const hasArtifact = manifest.artifacts.some(artifact => 
                artifact.model === model && artifact.hw_rev === hwRev && artifact.mcu === mcu
            );
            if (hasArtifact) {
                versions.add(manifest.version);
            }
        });
        
        Array.from(versions).forEach(version => {
            const option = document.createElement('option');
            option.value = version;
            option.textContent = version;
            versionSelect.appendChild(option);
        });
        
        this.resetSelector('romConfigSelect');
        document.getElementById('configDescription').classList.remove('visible');
    },
    
    filterByVersion(model, hwRev, mcu, version) {
        const romConfigSelect = document.getElementById('romConfigSelect');
        romConfigSelect.innerHTML = '<option value="">Select...</option>';
        romConfigSelect.disabled = false;
        
        const manifest = this.manifests.find(m => m.version === version);
        if (!manifest) return;
        
        this.filteredArtifacts = manifest.artifacts.filter(artifact =>
            artifact.model === model && artifact.hw_rev === hwRev && artifact.mcu === mcu
        );
        
        const sortedConfigs = this.filteredArtifacts
            .map(a => a.rom_config)
            .sort((a, b) => a.localeCompare(b));

        sortedConfigs.forEach(romConfig => {
            const option = document.createElement('option');
            option.value = romConfig;
            option.textContent = romConfig;
            romConfigSelect.appendChild(option);
        });
        
        document.getElementById('configDescription').classList.remove('visible');
    },
    
    selectRomConfig(romConfig) {
        this.selectedArtifact = this.filteredArtifacts.find(a => a.rom_config === romConfig);
        
        if (this.selectedArtifact) {
            const version = document.getElementById('versionSelect').value;
            const manifest = this.manifests.find(m => m.version === version);
            
            if (manifest && manifest.rom_configs && manifest.rom_configs[romConfig]) {
                const description = manifest.rom_configs[romConfig].description;
                const descDiv = document.getElementById('configDescription');
                descDiv.textContent = description;
                descDiv.classList.add('visible');
            }
        }
    },
    
    resetSelector(id) {
        const select = document.getElementById(id);
        select.innerHTML = '<option value="">Select...</option>';
        select.disabled = true;
    },
    
    async downloadAndVerify() {
        if (!this.selectedArtifact) {
            throw new Error('No artifact selected');
        }
        
        // Transform GitHub URL to use CORS proxy
        const proxyUrl = this.selectedArtifact.url.replace(
            /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/releases\/download\/(.+)$/,
            'https://github-cors.piers.rocks/github-release/$1/$2/$3'
        );
        
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error('Failed to download firmware: ' + response.status);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        
        // Verify SHA256
        if (this.selectedArtifact.sha256) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            if (hashHex !== this.selectedArtifact.sha256) {
                throw new Error('SHA256 checksum mismatch - firmware may be corrupted');
            }
        }
        
        return arrayBuffer;
    }
};

// Add event listeners for pre-built selectors
document.getElementById('modelSelect')?.addEventListener('change', function() {
    if (this.value) {
        PrebuiltManager.filterByModel(this.value);
    }
});

document.getElementById('hwRevSelect')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    if (this.value && model) {
        PrebuiltManager.filterByHwRev(model, this.value);
    }
});

document.getElementById('mcuSelectPrebuilt')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    const hwRev = document.getElementById('hwRevSelect').value;
    if (this.value && model && hwRev) {
        PrebuiltManager.filterByMcu(model, hwRev, this.value);
    }
});

document.getElementById('versionSelect')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    const hwRev = document.getElementById('hwRevSelect').value;
    const mcu = document.getElementById('mcuSelectPrebuilt').value;
    if (this.value && model && hwRev && mcu) {
        PrebuiltManager.filterByVersion(model, hwRev, mcu, this.value);
    }
});

document.getElementById('romConfigSelect')?.addEventListener('change', function() {
    if (this.value) {
        PrebuiltManager.selectRomConfig(this.value);
    }
});

// Handle tab switching
tabButtons.forEach(button => {
    button.addEventListener('click', function() {
        const targetTab = this.getAttribute('data-tab');
        
        // Update button states
        tabButtons.forEach(btn => btn.classList.remove('active'));
        this.classList.add('active');
        
        // Show/hide appropriate input
        tabInputs.forEach(input => {
            if (input.getAttribute('data-tab') === targetTab) {
                input.style.display = 'block';
            } else {
                input.style.display = 'none';
            }
        });
        
        // Hide/show program button and progress bar based on tab
        const buttonsAndBar = document.querySelector('.firmware-section .buttons-and-bar');
        if (targetTab === 'builder') {
            buttonsAndBar.style.display = 'none';
        } else {
            buttonsAndBar.style.display = 'flex';
        }
        
        // Initialize prebuilt manager on first view
        if (targetTab === 'prebuilt' && PrebuiltManager.manifests.length === 0) {
            PrebuiltManager.init();
        }
    });
});

// Initialize correct tab on page load
(function() {
    const activeButton = document.querySelector('.tab-button.active');
    if (activeButton) {
        const activeTab = activeButton.getAttribute('data-tab');
        
        // Show only the active tab's content
        tabInputs.forEach(input => {
            if (input.getAttribute('data-tab') === activeTab) {
                input.style.display = 'block';
            } else {
                input.style.display = 'none';
            }
        });
        
        // Initialize prebuilt manager if pre-built tab is active on load
        if (activeTab === 'prebuilt') {
            PrebuiltManager.init().then(() => {
                // Auto-select Ice and trigger cascade
                const modelSelect = document.getElementById('modelSelect');
                modelSelect.value = 'ice';
                modelSelect.style.display = 'none'; // Hide it
                PrebuiltManager.filterByModel('ice');
            });
        }
    }
})();

document.getElementById('fileUploadBox').addEventListener('change', function() {
    const fileNameSpan = document.getElementById('fileName');
    if (this.files.length > 0) {
        fileNameSpan.textContent = this.files[0].name;
        fileNameSpan.style.color = 'var(--one-rom-gold)';
    } else {
        fileNameSpan.textContent = 'No file selected';
        fileNameSpan.style.color = 'var(--text-secondary)';
    }
});

async function readAndDisplayDeviceInfo() {
    let firmwareData = null;
    
    // Save the original progress handler
    const originalProgressHandler = window.dfuProgressHandler;
    
    // Temporarily replace it to use the connect progress bar
    window.dfuProgressHandler = function(value) {
        connectProgressBar.value = value;
    };

    try {
        connectBtn.textContent = 'Reading';

        // Read first 64KB of firmware
        firmwareData = await dfu.upload(65536);
        
        // Parse with WASM
        let parsedInfo = await parse_firmware(firmwareData);

        // Check if we need to read the full chip for old firmware
        if (parsedInfo.major_version === 0 && parsedInfo.minor_version < 5 && 
            parsedInfo.parse_errors && parsedInfo.parse_errors.length > 0) {
            connectBtn.textContent = 'Re-reading';
            console.log('Pre v0.5.0 firmware detected, re-reading full chip for complete info');

            const fullSize = storageSizeMap[parsedInfo.stm_storage];
            if (fullSize) {
                // Re-read entire chip
                firmwareData = await dfu.upload(fullSize);

                // Re-parse with full data
                parsedInfo = await parse_firmware(firmwareData);
            } else {
                console.log('Unknown storage type for full chip read:', parsedInfo.stm_storage);
            }
        }
        
        // Populate device summary
        document.getElementById('deviceVersion').textContent = 
            `${parsedInfo.major_version}.${parsedInfo.minor_version}.${parsedInfo.patch_version}`;
        document.getElementById('deviceMcu').textContent = 
            getMcuVariantFromStrings(parsedInfo.stm_line, parsedInfo.stm_storage);
        
        if (parsedInfo.rom_sets.length > 0) {
            const allFilenames = parsedInfo.rom_sets
                .flatMap(set => set.roms.map(rom => rom.filename))
                .filter(name => name);
            
            const totalRoms = allFilenames.length;
            const sets = parsedInfo.rom_sets.length;
            
            // Show first 3 filenames, then indicate more
            if (totalRoms <= 3) {
                document.getElementById('deviceConfig').textContent = allFilenames.join(', ');
            } else {
                document.getElementById('deviceConfig').textContent = 
                    `${allFilenames.slice(0, 3).join(', ')} (+${totalRoms - 3} more in ${sets} set${sets > 1 ? 's' : ''})`;
            }
        } else {
            document.getElementById('deviceConfig').textContent = 'No ROMs';
        }

        if (parsedInfo.parse_errors && parsedInfo.parse_errors.length > 0) {
            document.getElementById('deviceStatus').textContent = 
                '⚠ - One ROM firmware corrupt';
        } else {
            document.getElementById('deviceStatus').textContent = 
                '✔ - One ROM firmware good';
        }
        document.getElementById('devicePcbRevision').textContent =
            parsedInfo.hw_rev || "Unknown";
        
        // Show device summary and details
        document.getElementById('deviceSummary').classList.remove('hidden');
        document.getElementById('deviceDetails').classList.remove('hidden');
        
        // Populate firmware details
        document.getElementById('deviceDetailsContent').textContent = 
            JSON.stringify(parsedInfo, null, 2);
            
        connectProgressBar.value = 100;
    } catch (error) {
        // If we got firmware data but parsing failed = unrecognized firmware
        if (firmwareData !== null) {
            // See if firmwareData is all 0xFF (erased chip)
            const allFF = firmwareData.every(byte => byte === 0xFF);
            if (allFF) {
                document.getElementById('deviceStatus').textContent = 
                    '✘ - No firmware (blank/erased chip)';
            } else {
                document.getElementById('deviceStatus').textContent = 
                    '✘ - Unrecognized firmware';
            }
            document.getElementById('deviceVersion').textContent = 'Unknown';
            document.getElementById('deviceMcu').textContent = 'Unknown';
            document.getElementById('deviceConfig').textContent = 'N/A';
            document.getElementById('devicePcbRevision').textContent = 'Unknown';
            document.getElementById('deviceSummary').classList.remove('hidden');
            document.getElementById('deviceDetailsContent').textContent = "";
            document.getElementById('deviceDetails').classList.add('hidden');
        } else {
            throw error;
        }
    }  finally {
        // Always restore the original handler
        window.dfuProgressHandler = originalProgressHandler;
        connectProgressBar.value = 0;
    }
}

document.getElementById('connectBtn').addEventListener('click', async function() {
    const connectBtn = this;
    const originalText = connectBtn.textContent;
    
    connectBtn.disabled = true;
    connectProgramButton.disabled = true;

    try {
        connectBtn.textContent = 'Connecting';
        
        await dfu.connect(true); // Force picker for manual connect
        
        connectBtn.textContent = 'Reading';
        await readAndDisplayDeviceInfo();
        
        connectBtn.textContent = 'Reconnect';
        connectBtn.disabled = false;
        
        await dfu.disconnect();
        
    } catch (error) {
        console.error('Error:', error);
        
        if (error.name === 'NotFoundError') {
            connectBtn.textContent = originalText;
            return;
        }
        
        alert('Failed to connect or read from device: ' + (error.message || error));
        connectBtn.textContent = originalText;
        
        try {
            await dfu.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
    } finally {
        connectProgramButton.disabled = false;
        connectBtn.disabled = false;
    }
});
