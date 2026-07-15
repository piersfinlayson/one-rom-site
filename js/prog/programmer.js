// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// =============================================================================
// ARCHITECTURAL NOTES / KNOWN ISSUES
// -----------------------------------------------------------------------------
// This file has grown organically and would benefit from a focused refactor.
// Issues are recorded here so they can be picked up as separate pieces of work.
//
// 1. Dropdowns conflate "user intent" with "current display state".
//    Each <select> (model, PCB, MCU, firmware version, ROM type, size handling,
//    CS logic, and now the plugin selects) is treated as the source of truth
//    for what the user chose. But these dropdowns are repopulated whenever the
//    device is re-detected (e.g. after a flash, applyDetectedDeviceToCustom ->
//    onModelChange resets the version, then onMcuChange re-selects it). During
//    that repopulate the option list is briefly emptied and rebuilt, which
//    discards the current selection before it can be restored - so a user's
//    choice is silently lost on the next re-detect/repopulate cycle.
//
//    The correct model is to track the user's INTENT separately from the
//    <select> value: only a genuine user change updates the intent, and every
//    repopulate re-applies the intent against the newly-available options
//    (selecting it if still offered, else falling back WITHOUT forgetting the
//    intent). This makes selections "sticky" across re-detects.
//
//    A NARROW version of this is implemented for the plugin selects only (see
//    systemPluginIntent / userPluginIntent in CustomImageManager). The GENERAL
//    fix - applying the same intent-tracking to model/PCB/MCU/version/ROM type/
//    size handling/CS - is deferred: it is a refactor of the manager's state
//    model touching every field's change handler, and deserves its own pass
//    with regression focus, rather than being bolted onto feature work.
//
//    The pattern relies on the user-change path being distinguishable from the
//    programmatic-repopulate path: user changes fire the 'change' listeners;
//    populate code sets .value directly and must NOT dispatch 'change'. This
//    holds today and any general refactor must preserve it.
// =============================================================================

import { compareChips } from '/js/site/utils.js'

const ONEROM_WASM_URL = 'https://wasm.onerom.org/releases/v0.4.0/pkg/onerom_wasm.js';
//const ONEROM_WASM_URL = 'http://localhost:8000/pkg/onerom_wasm.js';
const ONEROM_RELEASES_MANIFEST_URL = 'https://images.onerom.org/releases.json';
const FIRMWARE_SIZE = 48 * 1024;  // 48KB
const MAX_METADATA_LEN = 16 * 1024;  // 16KB

// Create a USB dfu device object
let dfu = new UnifiedProgrammer();

// Initialize WASM.
//
// The module must be initialised exactly once. Initialising it more than once -
// and especially concurrently - corrupts wasm-bindgen's memory (double frees,
// out-of-bounds access). Both the top-level parse path and the Custom Image
// Manager therefore share this single init promise and the one module instance.
let wasmInitialized = false;
let parse_firmware;
let resolve_plugin_label;
let wasmModule = null;

// Used to autodetect device properties from the connected device and pre-
// populate the relevant fields in the relevant tabs.
let detectedDevice = null;

const wasmReady = (async function() {
    const wasm = await import(ONEROM_WASM_URL);
    await wasm.default();
    wasmModule = wasm;
    parse_firmware = wasm.parse_firmware;
    resolve_plugin_label = wasm.resolve_plugin_label;
    wasmInitialized = true;
    return wasm;
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
    'F446RE': { line: 0x0003, storage: 0x04 },  // F446 + E
    'RP2350': { line: 0x0005, storage: 0x07 },  // RP2350 + 2MB flash (also, RP2354)
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

// Reference to the text boxes, button and progress bar
const mcuSelectBox = document.getElementById('mcuSelectBox');
const pageSizeBox = document.getElementById('pageSizeBox');
const connectProgramButton = document.getElementById('connectProgramButton');
const progressBar = document.getElementById('progressBar');
const connectProgressBar = document.getElementById('connectProgressBar');

// Stop and Run each have two identical controls: one in the Device section and
// a duplicate beside the Program button (so the user doesn't have to scroll up
// to realise the device must be Stopped before programming). Each logical
// button is backed by a LIST of elements that are toggled and wired in
// lockstep; a shared click handler drives every element in the list. Adding a
// third location later is just adding its ID here - no logic changes needed.
const stopButtons = ['stopBtn', 'progStopBtn'].map(id => document.getElementById(id));
const runButtons = ['runBtn', 'progRunBtn'].map(id => document.getElementById(id));

// Get references to tab elements
const tabButtons = document.querySelectorAll('.tab-button');
const tabInputs = document.querySelectorAll('.tab-input');

// When the button is clicked
connectProgramButton.addEventListener('click', function () {

    // Start the update function (This is an async process)
    startUpdate();
});

async function connectAndRead() {
    await dfu.connect(true);
    await readAndDisplayDeviceInfo();
    await dfu.disconnect();
    document.getElementById('connectBtn').textContent = 'Reconnect';
}

function updateDeviceButtons() {
    const inRunMode = dfu.isRunMode();
    const canRun = detectedDevice?.canRun ?? false;

    stopButtons.forEach(btn => btn.classList.toggle('hidden', !inRunMode));
    runButtons.forEach(btn => btn.classList.toggle('hidden', inRunMode || !canRun));

    // Programming only valid in stopped mode
    updateProgramButtonForCurrentTab();
}

async function stopDevice() {
    stopButtons.forEach(btn => btn.disabled = true);
    try {
        await dfu.reboot(true);
        await connectAndRead();
    } catch (error) {
        alert('Failed to stop device: ' + (error.message || error));
    } finally {
        stopButtons.forEach(btn => btn.disabled = false);
    }
}

async function runDevice() {
    runButtons.forEach(btn => btn.disabled = true);
    try {
        await dfu.reboot(false);
        await connectAndRead();
    } catch (error) {
        alert('Failed to run device: ' + (error.message || error));
    } finally {
        runButtons.forEach(btn => btn.disabled = false);
    }
}

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
        throw ("Error: Unknown MCU variant selected");
    }
    
    if (mcuLine !== expectedMcu.line || mcuStorage !== expectedMcu.storage) {
        const actualMcu = getMcuVariantName(mcuLine, mcuStorage);
        throw ("Error: One ROM firmware is for wrong MCU variant (Firmware is for " + 
                actualMcu + ", expected " + mcuVariant + ")");
    }
    
    // Check USB DFU support flag in extra_info block
    const pointerOffset = infoStructBase + 0x38;
    const flashBase = (mcuVariant === 'RP2350') ? 0x10000000 : 0x08000000;
    
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
                throw ("Error: No MCU variant selected");
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
                throw ("Error: No MCU variant selected");
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

        } else if (activeTab === 'custom') {
            // Custom Image tab: Use built firmware
        
            if (!CustomImageManager.builtFirmware) {
                throw ("Error: No firmware built");
            }
            
            fileArr = CustomImageManager.builtFirmware.buffer;
            mcuVariant = CustomImageManager.selectedMcu;
    
        } else {
            throw ("Error: No firmware source provided");
        }

        // Validate firmware before flashing
        validateFirmware(fileArr, mcuVariant);

        // Connect and verify device is not running
        await dfu.connect(false);
        if (dfu.isRunMode()) {
            await readAndDisplayDeviceInfo();
            await dfu.disconnect();
            throw ("Error: Device is running - press Stop before programming");
        }
        
        // Run the update sequence (existing code)
        await dfu.runUpdateSequence(fileArr, mcuVariant);

        // Automatically reconnect and refresh device info
        try {
            await dfu.connect(); // Use cached device, no picker
            await readAndDisplayDeviceInfo();
            await dfu.disconnect();

            // Update Connect button to Reconnect
            document.getElementById('connectBtn').textContent = 'Reconnect';

            // Show success message, then reset after 2 seconds
            dfuStatusHandler('Complete!');
            setTimeout(() => {
                dfuStatusHandler('Program');
            }, 2000);
        } catch (error) {
            console.log("Failed to auto-refresh device info: " + error);

            setTimeout(() => alert("One ROM USB Programming completed, but failed to read back device info"), 100);

            // Show success message, then reset after 2 seconds (even on error)
            dfuStatusHandler('Complete!');
            setTimeout(() => {
                dfuStatusHandler('Program');
            }, 2000);
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
        updateProgramButtonForCurrentTab();
        connectBtn.disabled = false;
    }
}

// Build GitHub issue URL with template
(function() {
    const title = "One ROM USB Site Issue - Brief Description Here";
    const body = `## Environment

**Browser and Version:** 
**Operating System:** 
**Board and MCU Variant:** 

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
                applyDetectedDeviceToPrebuilt();
                applyDetectedDeviceToCustom();
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
        this.selectedArtifact = null;

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
        
        // Convert Set to Array and sort by display name
        const sortedHwRevs = Array.from(hwRevs).sort((a, b) => {
            const manifestA = this.manifests.find(m => m.hardware[a]);
            const manifestB = this.manifests.find(m => m.hardware[b]);
            if (!manifestA || !manifestB) return 0;
            const displayA = manifestA.hardware[a].display;
            const displayB = manifestB.hardware[b].display;
            return displayA.localeCompare(displayB);
        });

        sortedHwRevs.forEach(hwRev => {
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
        this.selectedArtifact = null;
        
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
        this.selectedArtifact = null;

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
        this.selectedArtifact = null;
        
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
        if (dfu.isRunMode()) {
            connectProgramButton.disabled = true;
            return;
        }

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

        updateProgramButtonForCurrentTab();
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
    },
};

// Custom Image Manager
const CustomImageManager = {
    wasmInitialized: false,
    wasm: null,
    chipFile: null,
    chipFileName: null,
    builtFirmware: null,
    selectedBoard: null,
    selectedMcu: null,
    excludedRomTypes: [], // Global exclude list (empty for now)

    // Plugins (Fire only). pluginCatalog is the WASM PluginCatalog handle,
    // loaded lazily the first time the Fire model is selected. The selected
    // plugins hold { name, url, sha256, version } or null.
    pluginCatalog: null,
    pluginCatalogLoaded: false,
    selectedSystemPlugin: null,
    selectedUserPlugin: null,
    // User INTENT (chosen plugin name; '' means None), tracked separately from
    // the <select> value so it survives repopulation on re-detect. See the
    // architectural notes at the top of this file. System defaults to USB.
    systemPluginIntent: 'usb',
    userPluginIntent: '',
    
    async init() {
        if (this.wasmInitialized) return;
        
        try {
            // Reuse the single shared WASM instance; do NOT initialise the
            // module again (concurrent/double init corrupts its memory).
            this.wasm = await wasmReady;
            this.wasmInitialized = true;
            
            // Populate Model dropdown
            const models = ['Ice', 'Fire'];
            const modelSelect = document.getElementById('customModelSelect');
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                modelSelect.appendChild(option);
            });
            
            // Setup event listeners
            this.setupEventListeners();
            
            await applyDetectedDeviceToCustom();
        } catch (error) {
            console.error('Error initializing Custom Image Manager:', error);
            alert('Failed to initialize Custom Image Builder: ' + error.message);
        }
    },
    
    setupEventListeners() {
        // Model selection
        document.getElementById('customModelSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                this.onModelChange(e.target.value);
            } else {
                this.updateBuildButton();
            }
        });
        
        // PCB selection
        document.getElementById('customPcbSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                this.onPcbChange(e.target.value);
            } else {
                this.updateBuildButton();
            }
        });
        
        // MCU selection
        document.getElementById('customMcuSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                this.onMcuChange(e.target.value);
            } else {
                this.updateBuildButton();
            }
        });
        
        // Firmware version selection
        document.getElementById('customVersionSelect').addEventListener('change', () => {
            this.onPluginVersionChange();
            this.updateBuildButton();
        });

        // Plugin selections
        document.getElementById('customSystemPluginSelect').addEventListener('change', () => {
            this.onSystemPluginChange();
        });
        document.getElementById('customUserPluginSelect').addEventListener('change', () => {
            this.onUserPluginChange();
        });
        
        // ROM file upload
        document.getElementById('customRomFile').addEventListener('change', async (e) => {
            await this.onRomFileChange(e);
        });
        
        // ROM type selection
        document.getElementById('customRomTypeSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                this.onRomTypeChange(e.target.value);
            } else {
                this.updateBuildButton();
            }
        });

        // Size handling selection
        document.querySelectorAll('input[name="customSizeHandling"]').forEach(radio => {
            radio.addEventListener('change', () => {
                this.updateBuildButton();
            });
        });
        
        // CS selections
        ['customCs1Select', 'customCs2Select', 'customCs3Select'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                this.updateBuildButton();
            });
        });
        
        // Build button
        document.getElementById('customBuildBtn').addEventListener('click', async () => {
            await this.buildFirmware();
        });
        
        // Save button
        document.getElementById('customSaveBtn').addEventListener('click', () => {
            this.saveFirmware();
        });
    },
    
    async onModelChange(model) {
        // Get family from model
        const family = model === 'Fire' ? 'RP2350' : 'STM32F4';
        
        // Get boards for this family
        const boards = this.wasm.boards_for_mcu_family(family);
        
            
        // Filter to only boards with USB support
        const usbBoards = boards.filter(board => {
            const boardInfo = this.wasm.board_info(board.value);
            return boardInfo.has_usb === true;
        });
        
        // Sort alphabetically by display name (after removing "USB ")
        usbBoards.sort((a, b) => {
            const nameA = a.pretty.replace('USB ', '');
            const nameB = b.pretty.replace('USB ', '');
            return nameA.localeCompare(nameB);
        });

        // Populate PCB dropdown.  Pretty name needs USB removing
        const pcbSelect = document.getElementById('customPcbSelect');
        pcbSelect.innerHTML = '<option value="">Select...</option>';
        usbBoards.forEach(board => {
            const option = document.createElement('option');
            option.value = board.value;
            option.textContent = board.pretty.replace('USB ','');
            pcbSelect.appendChild(option);
        });
        pcbSelect.disabled = false;
        
        // Reset downstream
        this.resetSelect('customMcuSelect');
        this.resetSelect('customVersionSelect');
        this.resetSelect('customRomTypeSelect');
        this.hideCs();

        // Plugins are Fire-only. Show/hide synchronously and load the catalogue
        // in the background, so plugin loading never blocks or breaks the
        // device-config auto-fill that runs through this method.
        this.showPluginSection(model);

        this.updateBuildButton();
    },
    
    async onPcbChange(boardName) {
        this.selectedBoard = boardName;
        
        // Get board info
        const boardInfo = this.wasm.board_info(boardName);
        const family = boardInfo.mcu_family;
        
        // Get MCUs for this family
        const mcus = this.wasm.mcus_for_mcu_family(family);
        
        // Populate MCU dropdown
        const mcuSelect = document.getElementById('customMcuSelect');
        mcuSelect.innerHTML = '<option value="">Select...</option>';
        mcus.forEach(mcu => {
            if (mcu.value !== 'RP2350B') {
                const option = document.createElement('option');
                option.value = mcu.value;
                option.textContent = mcu.pretty;
                mcuSelect.appendChild(option);
            }
        });
        mcuSelect.disabled = false;
    
        // Auto-select MCU if only one option available
        if (mcus.length === 1) {
            mcuSelect.value = mcus[0].value;
            await this.onMcuChange(mcus[0].value);
        } else {
            // Reset downstream
            this.resetSelect('customVersionSelect');
        }
        this.updateRomTypes();
        this.updateBuildButton();
    },
    
    async onMcuChange(mcuVariant) {
        this.selectedMcu = mcuVariant;
        
        // Fetch firmware versions from releases.json
        try {
            const response = await fetch(ONEROM_RELEASES_MANIFEST_URL);
            const data = await response.json();
            
            // Filter compatible versions
            const board = this.selectedBoard.toLowerCase();
            const mcu = mcuVariant.toLowerCase();
            
            const compatible = data.releases.filter(release => {
                const boardData = release.boards.find(b => b.name === board);
                if (!boardData) return false;
                return boardData.mcus.some(m => m.name === mcu);
            }).map(r => r.version);
            
            // Populate version dropdown
            const versionSelect = document.getElementById('customVersionSelect');
            versionSelect.innerHTML = '<option value="">Select...</option>';
            compatible.forEach(version => {
                const option = document.createElement('option');
                option.value = version;
                option.textContent = `v${version}`;
                versionSelect.appendChild(option);
            });
            
            // Default to latest if available
            if (compatible.includes(data.latest)) {
                versionSelect.value = data.latest;
            }
            
            versionSelect.disabled = false;
            
        } catch (error) {
            console.error('Error fetching firmware versions:', error);
            alert('Failed to fetch firmware versions');
        }

        // The version was set programmatically above (no change event fires),
        // so refresh the plugin dropdowns for the newly-selected firmware.
        this.onPluginVersionChange();

        this.updateBuildButton();
    },
    
    async onRomFileChange(e) {
        const file = e.target.files[0];
        const fileNameSpan = document.getElementById('customRomFileName');
        
        if (!file) {
            this.chipFile = null;
            this.chipFileName = null;
            fileNameSpan.textContent = 'No file selected';
            fileNameSpan.classList.remove('selected');
            this.resetSelect('customRomTypeSelect');
            this.updateBuildButton();
            return;
        }
        
        this.chipFileName = file.name;
        this.chipFile = new Uint8Array(await file.arrayBuffer());
        
        fileNameSpan.textContent = file.name;
        fileNameSpan.classList.add('selected');
        
        // Enable ROM type selection
        if (this.selectedBoard) {
            this.updateRomTypes();
        }
        
        this.updateBuildButton();
    },
    
    updateRomTypes() {
        if (!this.selectedBoard) {
            this.resetSelect('customRomTypeSelect');
            return;
        }
        
        const boardInfo = this.wasm.board_info(this.selectedBoard);
        const boardRomPins = boardInfo.chip_pins;
        
        const allRomTypes = this.wasm.supported_chip_type_aliases();
        const extraTypes = this.wasm.extra_chip_types_for_board(this.selectedBoard);
        
        // Sort the chip types alphabetically to keep those of the same family
        // together, rather than the same underlying chip type
        const compatibleTypes = [
            ...new Set([
                ...allRomTypes.filter(alias => {
                    if (this.excludedRomTypes.includes(alias)) return false;
                    const chipInfo = this.wasm.chip_type_info(alias);
                    return chipInfo.chip_pins === boardRomPins;
                }),
                ...extraTypes.filter(alias => !this.excludedRomTypes.includes(alias))
            ])
        ].sort(compareChips);

        const chipTypeSelect = document.getElementById('customRomTypeSelect');
        const previousValue = chipTypeSelect.value;
        
        chipTypeSelect.innerHTML = '<option value="">Select...</option>';
        compatibleTypes.forEach(alias => {
            const option = document.createElement('option');
            option.value = alias;
            option.textContent = alias;
            chipTypeSelect.appendChild(option);
        });
        chipTypeSelect.disabled = false;

        if (previousValue && compatibleTypes.includes(previousValue)) {
            chipTypeSelect.value = previousValue;
        }
    },
    
    onRomTypeChange(chipType) {
        // Get ROM type info to check for CS lines
        const chipInfo = this.wasm.chip_type_info(chipType);
        
        // Hide all CS rows first
        this.hideCs();
        
        // Show CS rows based on control lines
        let csCount = 0;
        chipInfo.control_lines.forEach(line => {
            if (line.configurable) {
                csCount++;
                const csRow = document.getElementById(`customCs${csCount}Row`);
                if (csRow) {
                    csRow.classList.add('visible');
                }
            }
        });
        
        this.updateBuildButton();
    },
    
    hideCs() {
        ['customCs1Row', 'customCs2Row', 'customCs3Row'].forEach(id => {
            const row = document.getElementById(id);
            row.classList.remove('visible');
            document.getElementById(id.replace('Row', 'Select')).value = '';
        });
    },
    
    updateBuildButton() {
        const model = document.getElementById('customModelSelect').value;
        const pcb = document.getElementById('customPcbSelect').value;
        const mcu = document.getElementById('customMcuSelect').value;
        const version = document.getElementById('customVersionSelect').value;
        const chipType = document.getElementById('customRomTypeSelect').value;
        
        // Check if all required fields are filled
        let allFilled = model && pcb && mcu && version && this.chipFile && chipType;
        
        // Check CS lines if visible
        if (allFilled) {
            ['customCs1Row', 'customCs2Row', 'customCs3Row'].forEach(rowId => {
                const row = document.getElementById(rowId);
                if (row.classList.contains('visible')) {
                    const select = document.getElementById(rowId.replace('Row', 'Select'));
                    if (!select.value) {
                        allFilled = false;
                    }
                }
            });
        }
        
        // Plugin validation: a user plugin requires a system plugin. Show the
        // reason visibly rather than silently disabling the user control.
        const pluginMsg = this.getPluginValidationMessage();
        this.showPluginMessage(pluginMsg);
        if (pluginMsg) {
            allFilled = false;
        }

        document.getElementById('customBuildBtn').disabled = !allFilled;

        
        // Disable Program button - any form change invalidates built firmware
        updateProgramButtonForCurrentTab();
    },
    
    async buildFirmware() {
        const buildBtn = document.getElementById('customBuildBtn');
        buildBtn.disabled = true;
        buildBtn.textContent = 'Building...';
        
        try {
            // Build JSON config
            const config = this.buildConfig();
            const configJson = JSON.stringify(config);
            
            console.log('Config JSON:', configJson);
            
            // Get firmware version and family
            const version = document.getElementById('customVersionSelect').value;
            const boardInfo = this.wasm.board_info(this.selectedBoard);
            const family = boardInfo.mcu_family;
            
            // Download base firmware
            buildBtn.textContent = 'Downloading base firmware...';
            const baseFirmware = await this.downloadBaseFirmware(version, this.selectedBoard, this.selectedMcu);
            console.log('Base firmware:', baseFirmware.length, 'bytes');
            
            // Create builder
            buildBtn.textContent = 'Building config...';
            const builder = this.wasm.gen_builder_from_json(version, family, configJson);
            
            // Get file specs. With plugins there is one spec per plugin binary
            // (by URL) plus one for the ROM (by its in-memory filename).
            const fileSpecs = this.wasm.gen_file_specs(builder);
            console.log('File specs:', fileSpecs);

            // Add each file: the ROM from memory, plugin binaries fetched from
            // their URLs and SHA-256 verified against the manifest.
            for (const spec of fileSpecs) {
                if (spec.source === this.chipFileName) {
                    this.wasm.gen_add_file(builder, spec.id, Array.from(this.chipFile));
                } else {
                    buildBtn.textContent = 'Fetching plugin...';
                    const bytes = await this.fetchAndVerifyPlugin(spec.source);
                    this.wasm.gen_add_file(builder, spec.id, Array.from(bytes));
                }
            }
            
            // Build properties
            const versionParts = version.split('.');
            const properties = {
                version: {
                    major: parseInt(versionParts[0]),
                    minor: parseInt(versionParts[1]),
                    patch: parseInt(versionParts[2]),
                    build: 0
                },
                board: this.selectedBoard,
                mcu_variant: this.selectedMcu,
                serve_alg: 'default',
                boot_logging: true
            };
            
            // Build firmware
            buildBtn.textContent = 'Building metadata...';
            const images = this.wasm.gen_build(builder, properties);
            const metadata = new Uint8Array(images.metadata);
            const romImages = new Uint8Array(images.firmware_images);
                
            console.log('Metadata:', metadata.length, 'bytes');
            console.log('ROM images:', romImages.length, 'bytes');
            
            // Combine base firmware + metadata + ROM images
            buildBtn.textContent = 'Combining...';
            this.builtFirmware = this.combineFirmware(baseFirmware, metadata, romImages);
            
            console.log('Complete firmware:', this.builtFirmware.length, 'bytes');
            
            // Enable save and program buttons
            document.getElementById('customSaveBtn').disabled = false;
            updateProgramButtonForCurrentTab();

            buildBtn.textContent = 'Build Complete!';
            setTimeout(() => {
                try {
                    buildBtn.textContent = 'Build Firmware';
                    buildBtn.disabled = false;
                    updateProgramButtonForCurrentTab();
                } catch (error) {
                    console.error('Error in build button reset:', error);
                }
            }, 2000);
            
        } catch (error) {
            console.error('Build error:', error);
            alert('Failed to build firmware: ' + error);
            buildBtn.textContent = 'Build Firmware';
            buildBtn.disabled = false;
        }
    },
    
    buildConfig() {
        const chipType = document.getElementById('customRomTypeSelect').value;
        const sizeHandling = document.querySelector('input[name="customSizeHandling"]:checked').value;
        
        // Build ROM config
        const romConfig = {
            file: this.chipFileName,
            type: chipType,
            size_handling: sizeHandling
        };
        
        // Add CS lines if configured
        const chipInfo = this.wasm.chip_type_info(chipType);
        let csIndex = 1;
        chipInfo.control_lines.forEach(line => {
            if (line.configurable) {
                const csValue = document.getElementById(`customCs${csIndex}Select`).value;
                romConfig[`cs${csIndex}`] = csValue;
                csIndex++;
            }
        });
        
        // Build full config. Plugin chip_sets come first (system at index 0,
        // user at index 1), then the ROM set. rom_sets and chip_sets are
        // synonyms in the config, so array order is slot order.
        const romSets = this.getPluginChipSets();
        romSets.push({
            type: 'single',
            roms: [romConfig]
        });

        return {
            version: 1,
            description: `Custom single ROM: ${this.chipFileName}`,
            rom_sets: romSets
        };
    },
    
    async saveFirmware() {
        if (!this.builtFirmware) return;

        const pcbSelect = document.getElementById('customPcbSelect');
        const pcbName = pcbSelect.options[pcbSelect.selectedIndex].text
            .toLowerCase()
            .replace(/\s+/g, '-');
        const version = document.getElementById('customVersionSelect').value;
        const filename = `onerom-${pcbName}-v${version}-custom.bin`;

        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'Binary Files',
                        accept: { 'application/octet-stream': ['.bin'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(this.builtFirmware);
                await writable.close();
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Save error:', error);
                    alert('Failed to save file: ' + error.message);
                }
            }
        } else {
            const blob = new Blob([this.builtFirmware], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }
    },
    
    async downloadBaseFirmware(version, board, mcu) {
        // Fetch releases manifest
        const response = await fetch(ONEROM_RELEASES_MANIFEST_URL);
        const releases = await response.json();
        
        // Find the release
        const release = releases.releases.find(r => r.version === version);
        if (!release) {
            throw new Error(`Release ${version} not found`);
        }
        
        // Find the board
        const boardName = board.toLowerCase().replace(/_/g, '-');
        const boardData = release.boards.find(b => b.name === boardName);
        if (!boardData) {
            throw new Error(`Board ${board} not found in release ${version}`);
        }
        
        // Find the MCU
        const mcuName = mcu.toLowerCase();
        const mcuData = boardData.mcus.find(m => m.name === mcuName);
        if (!mcuData) {
            throw new Error(`MCU ${mcu} not found for board ${board} in release ${version}`);
        }
        
        // Build URL
        const releasePath = release.path || release.version;
        const boardPath = boardData.path || boardData.name;
        const mcuPath = mcuData.path || mcuData.name;
        const url = `https://images.onerom.org/${releasePath}/${boardPath}/${mcuPath}/firmware.bin`;
        
        console.log('Downloading base firmware from:', url);
        
        // Download
        const fwResponse = await fetch(url);
        if (!fwResponse.ok) {
            throw new Error(`Failed to download base firmware: ${fwResponse.status}`);
        }
        
        const arrayBuffer = await fwResponse.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    },

    combineFirmware(baseFirmware, metadata, romImages) {
        // Calculate total size
        const totalSize = FIRMWARE_SIZE + MAX_METADATA_LEN + romImages.length;
        const combined = new Uint8Array(totalSize);
        
        // Fill with 0xFF (erased flash)
        combined.fill(0xFF);
        
        // Copy base firmware at offset 0
        combined.set(baseFirmware, 0);
        
        // Copy metadata at offset FIRMWARE_SIZE
        combined.set(metadata, FIRMWARE_SIZE);
        
        // Copy ROM images at offset FIRMWARE_SIZE + MAX_METADATA_LEN
        combined.set(romImages, FIRMWARE_SIZE + MAX_METADATA_LEN);
        
        return combined;
    },
    
    resetSelect(id) {
        const select = document.getElementById(id);
        select.innerHTML = '<option value="">Select...</option>';
        select.disabled = true;
    },

    // ---- Plugins (Fire only) -------------------------------------------

    // Show or hide the plugins section for the current model. Loading the
    // catalogue happens in the background (Fire only) and never blocks this.
    showPluginSection(model) {
        const section = document.getElementById('customPluginsSection');
        if (model !== 'Fire') {
            section.classList.add('hidden');
            this.selectedSystemPlugin = null;
            this.selectedUserPlugin = null;
            this.clearPluginDropdowns();
            return;
        }
        section.classList.remove('hidden');
        if (this.pluginCatalogLoaded) {
            this.populatePluginDropdowns();
        } else {
            // Fire-and-forget: load then populate. Errors are contained here so
            // they can never propagate into the device-config flow.
            this.loadPluginsInBackground();
        }
    },

    // Load the catalogue (once) then populate the dropdowns. Self-contained:
    // any failure is logged, never thrown.
    async loadPluginsInBackground() {
        try {
            await this.initPluginCatalog();
            this.populatePluginDropdowns();
        } catch (error) {
            console.error('Plugin load failed:', error);
        }
    },

    clearPluginDropdowns() {
        document.getElementById('customSystemPluginSelect').innerHTML = '<option value="">None</option>';
        document.getElementById('customUserPluginSelect').innerHTML = '<option value="">None</option>';
    },

    // Load the plugin catalogue (once) via the WASM PluginCatalog, which fetches
    // the manifests through the JS callback below.
    async initPluginCatalog() {
        if (this.pluginCatalogLoaded) return;
        try {
            this.pluginCatalog = await this.wasm.plugin_catalog(
                (url) => this.pluginFetchCallback(url)
            );
            this.pluginCatalogLoaded = true;
        } catch (error) {
            console.error('Failed to load plugin catalogue:', error);
            this.pluginCatalog = null;
            // Section stays visible but the dropdowns offer only None.
        }
    },

    // JS fetch callback handed to the WASM catalogue loader: (url) => Uint8Array.
    async pluginFetchCallback(url) {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        }
        return new Uint8Array(await resp.arrayBuffer());
    },

    // Re-populate the plugin dropdowns for the currently-selected firmware
    // version. Called when the version changes (a plugin may gain or lose a
    // compatible release).
    onPluginVersionChange() {
        const model = document.getElementById('customModelSelect').value;
        if (model === 'Fire' && this.pluginCatalogLoaded) {
            this.populatePluginDropdowns();
        }
    },

    // Fill both dropdowns with plugins that have a release compatible with the
    // selected firmware, then re-apply the user's intent (see architectural
    // notes). Falls back when the intended plugin has no compatible release for
    // this firmware, but the intent is retained so it reappears when available.
    populatePluginDropdowns() {
        const fw = document.getElementById('customVersionSelect').value;
        const systemSelect = document.getElementById('customSystemPluginSelect');
        const userSelect = document.getElementById('customUserPluginSelect');

        this.fillPluginSelect(systemSelect, 'system_plugin', fw);
        this.fillPluginSelect(userSelect, 'user_plugin', fw);

        // Re-apply intent against the newly-available options (system falls back
        // to USB, user to None). Does NOT change the intent.
        this.applyPluginIntent(systemSelect, this.systemPluginIntent, 'usb');
        this.applyPluginIntent(userSelect, this.userPluginIntent, '');

        // Sync the resolved selections from the applied values.
        this.resolvePluginSelections();
    },

    // Fill one plugin select with the compatible plugins of the given type.
    fillPluginSelect(select, pluginType, fw) {
        select.innerHTML = '<option value="">None</option>';
        if (!this.pluginCatalog || !fw) return;

        const plugins = this.pluginCatalog.plugins()
            .filter(p => p.plugin_type === pluginType);

        plugins.forEach(p => {
            const rel = this.pluginCatalog.newest_compatible(p.name, fw);
            if (!rel) return;  // no release compatible with this firmware
            const option = document.createElement('option');
            option.value = p.name;
            const display = p.display_name || p.name;
            option.textContent = `${display} (v${rel.version})`;
            select.appendChild(option);
        });
    },

    // Apply an intent to a select: '' means the user intends None; a name that
    // is offered is selected; a name that is not offered (no compatible release
    // for this firmware) falls back, without altering the intent.
    applyPluginIntent(select, intent, fallback) {
        if (intent === '') {
            select.value = '';
        } else if (select.querySelector(`option[value="${intent}"]`)) {
            select.value = intent;
        } else if (fallback && select.querySelector(`option[value="${fallback}"]`)) {
            select.value = fallback;
        } else {
            select.value = '';
        }
    },

    // Resolve the selected plugins from the current <select> values, without
    // touching intent. Called after repopulation.
    resolvePluginSelections() {
        this.selectedSystemPlugin = this.resolveSelectedPlugin('customSystemPluginSelect');
        this.selectedUserPlugin = this.resolveSelectedPlugin('customUserPluginSelect');
        this.updateBuildButton();
    },

    // User changed the system dropdown: record the intent, then resolve.
    onSystemPluginChange() {
        this.systemPluginIntent = document.getElementById('customSystemPluginSelect').value;
        this.selectedSystemPlugin = this.resolveSelectedPlugin('customSystemPluginSelect');
        this.updateBuildButton();
    },

    // User changed the user dropdown: record the intent, then resolve.
    onUserPluginChange() {
        this.userPluginIntent = document.getElementById('customUserPluginSelect').value;
        this.selectedUserPlugin = this.resolveSelectedPlugin('customUserPluginSelect');
        this.updateBuildButton();
    },

    // Resolve the selected plugin in a dropdown to { name, url, sha256, version },
    // or null if None (or no compatible release).
    resolveSelectedPlugin(selectId) {
        const name = document.getElementById(selectId).value;
        if (!name || !this.pluginCatalog) return null;
        const fw = document.getElementById('customVersionSelect').value;
        const rel = this.pluginCatalog.newest_compatible(name, fw);
        if (!rel) return null;
        return { name, url: rel.url, sha256: rel.sha256, version: rel.version };
    },

    // A user plugin requires a system plugin; return the reason to block the
    // build, or '' when valid.
    getPluginValidationMessage() {
        if (this.selectedUserPlugin && !this.selectedSystemPlugin) {
            return 'A user plugin requires a system plugin. Select a system plugin, or set the user plugin to None.';
        }
        return '';
    },

    showPluginMessage(msg) {
        const el = document.getElementById('customPluginMessage');
        el.textContent = msg;
        el.classList.toggle('visible', !!msg);
    },

    // Plugin chip_sets for the config: system first (slot 0), user second
    // (slot 1). Each is a single set with one plugin chip.
    getPluginChipSets() {
        const sets = [];
        if (this.selectedSystemPlugin) {
            sets.push(this.pluginChipSet(this.selectedSystemPlugin.url, 'system_plugin'));
        }
        if (this.selectedUserPlugin) {
            sets.push(this.pluginChipSet(this.selectedUserPlugin.url, 'user_plugin'));
        }
        return sets;
    },

    pluginChipSet(url, type) {
        return { type: 'single', roms: [{ file: url, type, size_handling: 'pad' }] };
    },

    // Fetch a plugin binary and verify its SHA-256 against the manifest digest.
    async fetchAndVerifyPlugin(url) {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Failed to fetch plugin ${url}: ${resp.status}`);
        }
        const buffer = await resp.arrayBuffer();

        const expected = this.pluginSha256ForUrl(url);
        if (expected) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashHex = Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0')).join('');
            if (hashHex !== expected.toLowerCase()) {
                throw new Error(`Plugin SHA-256 mismatch for ${url}`);
            }
        }
        return new Uint8Array(buffer);
    },

    pluginSha256ForUrl(url) {
        if (this.selectedSystemPlugin && this.selectedSystemPlugin.url === url) {
            return this.selectedSystemPlugin.sha256;
        }
        if (this.selectedUserPlugin && this.selectedUserPlugin.url === url) {
            return this.selectedUserPlugin.sha256;
        }
        return null;
    }
};

// Helper functions to check if tabs are ready
function isUrlTabReady() {
    const mcuSelect = document.getElementById('mcuSelectUrl');
    const urlInput = document.getElementById('fileLocationBox');
    return mcuSelect.value !== '' && urlInput.value.trim() !== '';
}

function isFileTabReady() {
    const mcuSelect = document.getElementById('mcuSelectFile');
    const fileInput = document.getElementById('fileUploadBox');
    return mcuSelect.value !== '' && fileInput.files && fileInput.files.length > 0;
}

function isPrebuiltTabReady() {
    return PrebuiltManager.selectedArtifact !== null;
}

function updateProgramButtonForCurrentTab() {
    console.log('updateProgramButtonForCurrentTab: isRunMode=', dfu.isRunMode());
    if (dfu.isRunMode()) {
        connectProgramButton.disabled = true;
        return;
    }

    const activeTab = document.querySelector('.tab-button.active').getAttribute('data-tab');
    
    if (activeTab === 'url') {
        connectProgramButton.disabled = !isUrlTabReady();
    } else if (activeTab === 'file') {
        connectProgramButton.disabled = !isFileTabReady();
    } else if (activeTab === 'prebuilt') {
        connectProgramButton.disabled = !isPrebuiltTabReady();
    } else if (activeTab === 'custom') {
        connectProgramButton.disabled = !CustomImageManager.builtFirmware;
    }
}

// Add event listeners for pre-built selectors
document.getElementById('modelSelect')?.addEventListener('change', function() {
    if (this.value) {
        PrebuiltManager.filterByModel(this.value);
    }
    updateProgramButtonForCurrentTab();
});

document.getElementById('hwRevSelect')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    if (this.value && model) {
        PrebuiltManager.filterByHwRev(model, this.value);

        // Auto-select MCU if only one option available
        const mcuSelect = document.getElementById('mcuSelectPrebuilt');
        if (mcuSelect.options.length === 2) { // placeholder + one option
            mcuSelect.selectedIndex = 1;
            mcuSelect.dispatchEvent(new Event('change'));
        }
    }
    updateProgramButtonForCurrentTab();
});

document.getElementById('mcuSelectPrebuilt')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    const hwRev = document.getElementById('hwRevSelect').value;
    if (this.value && model && hwRev) {
        PrebuiltManager.filterByMcu(model, hwRev, this.value);
    }
    updateProgramButtonForCurrentTab();
});

document.getElementById('versionSelect')?.addEventListener('change', function() {
    const model = document.getElementById('modelSelect').value;
    const hwRev = document.getElementById('hwRevSelect').value;
    const mcu = document.getElementById('mcuSelectPrebuilt').value;
    if (this.value && model && hwRev && mcu) {
        PrebuiltManager.filterByVersion(model, hwRev, mcu, this.value);
    }
    updateProgramButtonForCurrentTab();
});

document.getElementById('romConfigSelect')?.addEventListener('change', function() {
    if (this.value) {
        PrebuiltManager.selectRomConfig(this.value);
    }
    updateProgramButtonForCurrentTab();
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

        // Update program button for the new active tab
        updateProgramButtonForCurrentTab();

        // Initialize prebuilt manager if pre-built tab is active on load
        if (targetTab === 'prebuilt' && PrebuiltManager.manifests.length === 0) {
            PrebuiltManager.init();
        } else if (targetTab === 'prebuilt') {
            applyDetectedDeviceToPrebuilt();
        }

        // Initialize custom image manager on first view
        if (targetTab === 'custom' && !CustomImageManager.wasmInitialized) {
            CustomImageManager.init();
        } else if (targetTab === 'custom') {
            applyDetectedDeviceToCustom();
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
        
        // Initialize the manager for whichever tab is active on load, so a
        // device connected before any tab switch still auto-fills.
        if (activeTab === 'prebuilt') {
            PrebuiltManager.init();
        } else if (activeTab === 'custom') {
            CustomImageManager.init();
        }
    }

   // Initialize Program button state
   updateProgramButtonForCurrentTab();
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
    updateProgramButtonForCurrentTab();
});

// URL tab event listeners
document.getElementById('mcuSelectUrl').addEventListener('change', updateProgramButtonForCurrentTab);
document.getElementById('fileLocationBox').addEventListener('input', updateProgramButtonForCurrentTab);

// File tab event listeners
document.getElementById('mcuSelectFile').addEventListener('change', updateProgramButtonForCurrentTab);

function applyDetectedDeviceToPrebuilt() {
    if (PrebuiltManager.manifests.length === 0) return;

    const device = detectedDevice ?? { model: 'fire', hw_rev: 'fire-28-a', mcu: 'RP2350' };

    const modelSelect = document.getElementById('modelSelect');
    modelSelect.value = device.model;
    PrebuiltManager.filterByModel(device.model);

    if (!device.hw_rev) return;

    const hwRevSelect = document.getElementById('hwRevSelect');
    if (!hwRevSelect.querySelector(`option[value="${device.hw_rev}"]`)) return;
    hwRevSelect.value = device.hw_rev;
    PrebuiltManager.filterByHwRev(device.model, device.hw_rev);

    const mcuLower = device.mcu.toLowerCase();
    const mcuSelect = document.getElementById('mcuSelectPrebuilt');
    if (!mcuSelect.querySelector(`option[value="${mcuLower}"]`)) return;
    mcuSelect.value = mcuLower;
    PrebuiltManager.filterByMcu(device.model, device.hw_rev, mcuLower);

    // Select latest version (manifests loaded latest-first, so first option after placeholder)
    const versionSelect = document.getElementById('versionSelect');
    if (versionSelect.options.length > 1) {
        versionSelect.selectedIndex = 1;
        const version = versionSelect.value;
        PrebuiltManager.filterByVersion(device.model, device.hw_rev, mcuLower, version);
    }

    updateProgramButtonForCurrentTab();
}

async function applyDetectedDeviceToCustom() {
    if (!CustomImageManager.wasmInitialized) return;

    const device = detectedDevice ?? {
        model: 'Fire',
        hw_rev: 'fire-28-a',
        mcu: 'RP2350'
    };

    const previousRomType = document.getElementById('customRomTypeSelect').value;

    const modelSelect = document.getElementById('customModelSelect');

    const modelValue = device.model === 'fire' ? 'Fire' : device.model === 'ice' ? 'Ice' : device.model;
    modelSelect.value = modelValue;
    await CustomImageManager.onModelChange(modelValue);

    if (!device.hw_rev) return;

    const pcbSelect = document.getElementById('customPcbSelect');
    if (!pcbSelect.querySelector(`option[value="${device.hw_rev}"]`)) return;
    pcbSelect.value = device.hw_rev;
    await CustomImageManager.onPcbChange(device.hw_rev);

    const mcuSelect = document.getElementById('customMcuSelect');
    if (!mcuSelect.querySelector(`option[value="${device.mcu}"]`)) return;
    mcuSelect.value = device.mcu;
    await CustomImageManager.onMcuChange(device.mcu);
    // onMcuChange already auto-selects latest version

    const romTypeSelect = document.getElementById('customRomTypeSelect');
    if (previousRomType && romTypeSelect.querySelector(`option[value="${previousRomType}"]`)) {
        romTypeSelect.value = previousRomType;
        CustomImageManager.onRomTypeChange(previousRomType);
    }
}

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

        // Read the first 64KB of flash. Metadata - and therefore the plugin/ROM
        // list - lives within this range for both firmware generations.
        firmwareData = await dfu.upload(65536);

        // RAM read callback handed to parse_firmware. The parser calls it to
        // follow runtime pointers into RAM, which is what lets us report the
        // active ROM. Only a running Fire has live runtime info, so for anything
        // else (a stopped Fire in the bootloader, or an Ice device, which is
        // never running) we reject immediately: the parser then tolerantly
        // treats the runtime as absent - the device shows as stopped and nothing
        // is marked active - rather than reading and misinterpreting stale RAM.
        const canReadRam = dfu.getDeviceType() === 'Fire' && dfu.isRunMode();
        const readCb = canReadRam
            ? (addr, len) => dfu.readMemory(addr, len)
            : () => Promise.reject(new Error('RAM unavailable: device not running'));

        // Parse the flash image; RAM is fetched on demand through readCb.
        let summary = await parse_firmware(firmwareData, readCb);

        // Pre-v0.5.0 firmware read from a partial dump parses with errors. The
        // WASM reports the full chip size to re-read; do so and re-parse.
        if (summary.full_reread_size) {
            connectBtn.textContent = 'Re-reading';
            console.log('Pre-v0.5.0 firmware: re-reading full chip for complete info');
            firmwareData = await dfu.upload(summary.full_reread_size);
            summary = await parse_firmware(firmwareData, readCb);
        }

        // No version means this is not recognisable One ROM firmware. Tell a
        // blank (all-0xFF) chip apart from unrecognised contents.
        if (!summary.version) {
            const allFF = firmwareData.every(byte => byte === 0xFF);
            document.getElementById('deviceStatus').textContent = allFF
                ? '✘ - No firmware (blank/erased chip)'
                : '✘ - Unrecognized firmware';
            document.getElementById('deviceVersion').textContent = 'Unknown';
            document.getElementById('deviceMcu').textContent = 'Unknown';
            document.getElementById('deviceConfig').textContent = 'N/A';
            document.getElementById('devicePcbRevision').textContent = 'Unknown';
            document.getElementById('devicePluginsRow').classList.add('hidden');
            document.getElementById('deviceSummary').classList.remove('hidden');
            document.getElementById('deviceDetailsContent').textContent = '';
            document.getElementById('deviceDetails').classList.add('hidden');
            connectProgressBar.value = 100;
            updateDeviceButtons();
            return;
        }

        // Status: a corrupt parse overrides everything; otherwise the run state
        // comes from the USB interface (authoritative), not the parse.
        document.getElementById('deviceStatus').textContent = summary.corrupt
            ? '⚠ - One ROM firmware corrupt'
            : '✔ - One ROM firmware good (' + (dfu.isRunMode() ? 'Running' : 'Stopped') + ')';

        document.getElementById('deviceVersion').textContent = summary.version;
        document.getElementById('deviceMcu').textContent = summary.mcu || 'Unknown';
        document.getElementById('devicePcbRevision').textContent = summary.hw_rev || 'Unknown';

        // Plugins get their own line, shown only when present. The active entry
        // (running devices only) is marked. The labels are the raw image
        // sources at first; upgradePluginLabels then replaces them with friendly
        // names (manifest display name for official plugins, file stem for
        // local ones) as those resolve - best-effort, non-blocking.
        const pluginsRow = document.getElementById('devicePluginsRow');
        const pluginsEl = document.getElementById('devicePlugins');
        if (summary.plugins.length > 0) {
            pluginsEl.textContent = summary.plugins.map(formatRomEntry).join(', ');
            pluginsRow.classList.remove('hidden');
            // Fire-and-forget: enhance the labels in the background. A slow or
            // failed manifest fetch simply leaves the raw label in place.
            upgradePluginLabels(summary.plugins, pluginsEl);
        } else {
            pluginsRow.classList.add('hidden');
        }

        // ROMs line, truncated to the first three.
        const romLabels = summary.roms.map(formatRomEntry);
        if (romLabels.length === 0) {
            document.getElementById('deviceConfig').textContent = 'No ROMs';
        } else if (romLabels.length <= 3) {
            document.getElementById('deviceConfig').textContent = romLabels.join(', ');
        } else {
            document.getElementById('deviceConfig').textContent =
                `${romLabels.slice(0, 3).join(', ')} (+${romLabels.length - 3} more)`;
        }

        // Store for pre-population of the programming tabs, but only when the
        // parse was clean. canRun comes straight from the WASM (has the USB
        // system plugin) rather than being re-derived here.
        if (!summary.corrupt) {
            detectedDevice = {
                model: (summary.model || '').toLowerCase() || null,
                hw_rev: summary.hw_rev || null,
                mcu: summary.mcu || null,
                canRun: summary.can_run,
            };
            applyDetectedDeviceToPrebuilt();
            applyDetectedDeviceToCustom();
        }

        // Show summary and details.
        document.getElementById('deviceSummary').classList.remove('hidden');
        document.getElementById('deviceDetails').classList.remove('hidden');

        // Details pane: the full parse, pretty-printed. Its shape differs by
        // format (Original vs Schema) - render whatever the dump contains.
        try {
            document.getElementById('deviceDetailsContent').textContent =
                JSON.stringify(JSON.parse(summary.dump), null, 2);
        } catch {
            document.getElementById('deviceDetailsContent').textContent = summary.dump;
        }

        connectProgressBar.value = 100;

        updateDeviceButtons();
    } catch (error) {
        // A genuine failure (USB/transport, or a WASM error). If we never got
        // any firmware data the failure is upstream, so rethrow; otherwise show
        // it as unrecognised firmware.
        if (firmwareData !== null) {
            document.getElementById('deviceStatus').textContent =
                '✘ - Unrecognized firmware';
            document.getElementById('deviceVersion').textContent = 'Unknown';
            document.getElementById('deviceMcu').textContent = 'Unknown';
            document.getElementById('deviceConfig').textContent = 'N/A';
            document.getElementById('devicePcbRevision').textContent = 'Unknown';
            document.getElementById('devicePluginsRow').classList.add('hidden');
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

// Format a DeviceSummary ROM/plugin entry for display, appending "(active)" to
// the slot currently being served (running devices only).
function formatRomEntry(entry) {
    return entry.active ? `${entry.label} (active)` : entry.label;
}

// Fetch callback handed to resolve_plugin_label: (url) => Uint8Array. Mirrors
// the plugin-catalogue fetch; invoked by the WASM only for official plugins, to
// retrieve their release manifest. Local plugins never trigger a fetch.
async function pluginManifestFetch(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
}

// Replace each plugin's raw image-source label with a friendly name resolved by
// the WASM `resolve_plugin_label`, then re-render the plugins line. Best-effort:
// a plugin that fails to resolve (or an unreachable manifest) keeps its raw
// label, and the "(active)" marker is preserved throughout. Plugins are passed
// by their index in the list, which is their slot order (0 = system, 1 = user).
async function upgradePluginLabels(plugins, element) {
    if (!resolve_plugin_label) return; // WASM not initialised

    const labels = await Promise.all(
        plugins.map(async (entry, index) => {
            try {
                const info = await resolve_plugin_label(index, entry.label, pluginManifestFetch);
                const label = info?.label ?? entry.label;
                return entry.active ? `${label} (active)` : label;
            } catch {
                // Keep the raw label on any failure.
                return formatRomEntry(entry);
            }
        })
    );

    element.textContent = labels.join(', ');
}

stopButtons.forEach(btn => btn.addEventListener('click', stopDevice));
runButtons.forEach(btn => btn.addEventListener('click', runDevice));
document.getElementById('connectBtn').addEventListener('click', async function() {
    const connectBtn = this;
    const originalText = connectBtn.textContent;
    
    connectBtn.disabled = true;
    connectProgramButton.disabled = true;

    try {
        connectBtn.textContent = 'Connecting';
        
        await connectAndRead();
        
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
        updateProgramButtonForCurrentTab();
        connectBtn.disabled = false;
    }
});

// Updates the button text. "Connecting", "Erasing", etc.
window.dfuStatusHandler = function(status) {
    connectProgramButton.innerHTML = status;
}

// Updates the progress bar value. 0 - 100%
window.dfuProgressHandler = function(value) {
    progressBar.value = value;
}

// This function is called on a disconnect event
window.dfuDisconnectHandler = function() {

    // Reset the button back to 'connect'
    connectProgramButton.innerHTML = "Program";

    // Enable the button again
    updateProgramButtonForCurrentTab();

    // Reset the progress bar
    progressBar.value = 0;
}