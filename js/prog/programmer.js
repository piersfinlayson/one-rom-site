// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// =============================================================================
// ARCHITECTURAL NOTES / KNOWN ISSUES
// -----------------------------------------------------------------------------
// This file has grown organically and would benefit from a focused refactor.
// Issues are recorded here so they can be picked up as separate pieces of work.
//
// 1. The state model conflates "user intent" with "current display state".
//    There is no single place that stores "what the user chose" separately
//    from "what the <select> currently shows".
//    On every re-detect (e.g. after a flash) applyDetectedDeviceToCustom
//    rebuilds model -> PCB -> MCU -> version -> ROM type from the connected
//    device, emptying and repopulating each dropdown. With no stored intent, a
//    repopulate can only reconstruct a selection from whatever source it
//    happens to consult.
//
//    Today this is harmless for model, PCB, MCU and ROM type - but ONLY because
//    a re-read returns exactly what the user just programmed, so the device
//    report and the user's choice coincide. That is a property of the domain,
//    not a guarantee of the design. The one deliberate override - debrick,
//    setting fields by hand to flash a device that reports nothing useful -
//    self-corrects once flashed.
//
//    Where intent genuinely diverges from the device, it has been patched
//    field by field rather than modelled once:
//      - version:  versionIntent (upgrade, or testing a build not yet latest)
//      - plugins:  systemPluginIntent / userPluginIntent (a build-time choice
//                  the device read does not dictate)
//      - ROM type: previousRomType + updateRomTypes' previousValue - preservation
//                  across a repopulate, which suffices only because of the
//                  read-back convergence above
//    Three overlapping ad-hoc mechanisms now do by hand what one intent model
//    would do once.
//
//    Why this stays a KNOWN ISSUE and is not "done": any new field, or any
//    detection path that does not report back exactly what was programmed,
//    reintroduces the silent-loss bug and needs yet another bolt-on. The
//    eventual fix is a single intent model - store intent per field on genuine
//    user change; on every repopulate re-apply it against the available options
//    (keep it if still offered, else fall back WITHOUT forgetting it). It is
//    deferred, not unnecessary: deferred because the damage is contained (see
//    note 2 - a build whose form was repopulated under it can no longer be
//    programmed or saved, so a stale selection forces a rebuild rather than a
//    wrong flash), not because the conflation has gone away.
//
//    Any such mechanism relies on the user-change path being distinguishable
//    from the programmatic-repopulate path: user changes fire the 'change'
//    listeners; populate code sets .value directly and must NOT dispatch
//    'change'. versionIntent and the plugin intents already depend on this.
//
//    (CS logic selects and the size handling radios are static markup - their
//    options never change, so they are never repopulated and need no handling.
//    CS was once lost for an unrelated reason: hideCs() cleared the values as a
//    side effect of hiding the rows; it no longer does.)
//
// 2. Built firmware is only valid for the configuration it was built from.
//    CustomImageManager.builtFirmware is paired with builtFrom, a signature of
//    every input the build consumed (configSignature). hasCurrentBuild() gates
//    Program and Save on the two still agreeing.
//
//    This exists because the form changes without the user touching it - see
//    note 1 - so "the user has not edited anything" is not a safe proxy for
//    "the image still matches the form". Signature comparison is used in
//    preference to invalidating on every change event, because the repopulate
//    after a successful flash re-applies identical values, and binning a
//    perfectly good image there would be a false positive.
//
//    The ROM file is identified by a generation counter, not its name or size:
//    rebuilding a ROM from source yields the same filename, and ROM images are
//    a fixed size, so neither can tell two selections apart. Note also that a
//    file input only fires 'change' when its value differs - and its value is
//    the path - so onRomFileChange clears it, or re-selecting the same file
//    after editing it would be silently ignored.
//
// 3. A device read performed during an operation must not touch the page.
//    readAndDisplayDeviceInfo repopulates the tabs via applyDetectedDeviceToCustom
//    (note 1), which is correct for the Connect button but destroys user state
//    if called mid-operation. readAndParseDevice is the side-effect-free read,
//    and is what the pre-programming board check uses. Keep display logic in the
//    former and reads in the latter; do not call the former from an operation.
//
//    readAndParseDevice throws only if the flash could not be READ. Flash that
//    reads but cannot be interpreted returns a null summary, because callers
//    treat "I could not talk to the board" and "this board is not running
//    firmware I understand" very differently.
//
// 4. DeviceSummary.can_run means different things on Ice and Fire, and the name
//    matches neither. It is is_usb_run_capable(): on Fire it reports whether a
//    system plugin is present; on Ice it is always false, because an Ice only
//    ever presents as an STM32 DFU bootloader and so can never run over USB.
//
//    It does NOT mean "manageable over USB", and it is not the v1 USB DFU
//    support flag, which the parser does not surface at all - that has to be
//    read out of the image by hand (assertIceImageSupportsUsb). can_run has
//    caused three bugs by being assumed to be one of those: it rejected every
//    Ice image, it made restart-after-programming throw on Ice, and it left the
//    Run button showing on Ice. Every consumer here works around it; the fix
//    belongs on the Rust side.
//
// 5. The plugin catalogue loads in the background (loadPluginsInBackground),
//    deliberately, so that a slow or failed fetch cannot block or break the
//    device auto-fill. The consequence is that selectedSystemPlugin is null
//    until it lands. Building in that window produces an image with no plugins,
//    and its signature (note 2) records none - so when the catalogue arrives and
//    the intent is applied, the build immediately goes stale. Suspected but not
//    confirmed; hasCurrentBuild() logs which field moved, so the console will
//    say 'systemPlugin' if this is what has happened.
//
// 6. A One ROM's identity is only knowable from the firmware already on it.
//    There is no hardware identifier to interrogate, so the pre-programming
//    board check (confirmBoardBeforeProgramming) compares what the board's
//    CURRENT firmware claims against what the image being flashed is for. Three
//    consequences follow, and they shape the whole design:
//
//    - A board that has already been mis-flashed claims to be whatever was
//      wrongly put on it. The check therefore fires on exactly the case where
//      the user is right and the board is lying - de-bricking - and cannot tell
//      that apart from a user about to make the original mistake. So it WARNS
//      and allows; blocking would prevent the repair it exists to make rarer.
//    - A blank or unreadable board cannot be checked at all. That case falls
//      back to asking the user to check the silkscreen, which is why the
//      revision letter is derived from the board name (boardRevisionLabel).
//    - Both sides of the comparison come from parse_firmware, never from the
//      dropdowns, so the check works identically on all four tabs - including
//      URL and Local, which only ever knew the MCU.
//
//    Writing board identity to the RP2350's OTP is planned. That supersedes all
//    of this: the board would then answer for itself, the blank-board silkscreen
//    prompt would apply only to pre-OTP boards, and a mis-flashed board would no
//    longer be able to lie. Do not invest further here in the meantime.
//
// 7. On Fire, the USB PID *is* the run state: f540 stopped, f542 running. Any
//    lookup that pins the PID a device was last seen with therefore cannot find
//    it after a reboot - the PID has changed by definition. This is why
//    UnifiedProgrammer.connect() matches getDevices() against the whole One ROM
//    PID list (ONEROM_USB_DEVICES) rather than the cached PID, and it is why
//    Stop and Run used to put up a device picker every single time.
//
//    Reconnecting therefore goes through rebootAndReconnect(), which waits for
//    the device to reappear under a DIFFERENT PID - both because the mode must
//    change, and to avoid latching onto the outgoing device in the window before
//    the host notices it detach. It reconnects silently provided the target
//    mode's PID has been authorised before, which matters because after a flash
//    there is no user activation left and a picker may not be permitted to
//    appear at all.
// =============================================================================

import { compareChips } from '/js/site/utils.js'

const ONEROM_WASM_URL = 'https://wasm.onerom.org/releases/v0.4.1/pkg/onerom_wasm.js';
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
    // forcePicker: the Connect button is where the user chooses which device to
    // talk to, so it always asks. Run and Stop must not - see rebootAndRead.
    await dfu.connect(true);
    await readAndReleaseDevice();
}

// Reboot into the requested mode and show what came back, without asking the
// user to pick the device again: they already chose it, and the reboot only
// changed the mode it presents as.
//
// Deliberately does NOT fall back to the picker when the reattach fails. By that
// point the click's user activation is gone - spent by the reboot's own connect,
// or timed out waiting for a device that was never going to appear - so asking
// for one throws a SecurityError instead of showing anything. The reboot itself
// has already succeeded, so the honest thing is to say so and let the user's
// next click be a fresh gesture that can grant the new mode's PID. It only
// happens once per mode per origin; after that the reattach is silent.
async function rebootAndRead(stopped) {
    if (!await dfu.rebootAndReconnect(stopped)) {
        alert(stopped
            ? 'One ROM has been stopped, but cannot reconnect automatically.  Press Connect to re-connect manually.'
            : 'One ROM has been restarted, but cannot reconnect automatically.  Press Connect to re-connect manually.');
        return;
    }
    await readAndReleaseDevice();
}

// Read and display the connected device, then let go of it: holding the handle
// open would stop anything else - including the device itself rebooting - from
// using it.
async function readAndReleaseDevice() {
    await readAndDisplayDeviceInfo();
    await dfu.disconnect();
    document.getElementById('connectBtn').textContent = 'Reconnect';
}

function updateDeviceButtons() {
    const inRunMode = dfu.isRunMode();
    const canRun = detectedDevice?.canRun ?? false;

    // Running and stopping over USB is Fire-only: Ice always presents in STM32
    // DFU bootloader mode. canRun cannot stand in for this - on Ice it reports
    // the v1 USB DFU build flag, which is true for any USB-programmable Ice.
    const isFire = detectedDevice?.model === 'fire';

    stopButtons.forEach(btn => btn.classList.toggle('hidden', !isFire || !inRunMode));
    runButtons.forEach(btn => btn.classList.toggle('hidden', !isFire || inRunMode || !canRun));

    updateProgramButtonForCurrentTab();
}

async function stopDevice() {
    stopButtons.forEach(btn => btn.disabled = true);
    try {
        await rebootAndRead(true);
    } catch (error) {
        alert('Failed to stop device: ' + (error.message || error));
    } finally {
        stopButtons.forEach(btn => btn.disabled = false);
    }
}

async function runDevice() {
    runButtons.forEach(btn => btn.disabled = true);
    try {
        await rebootAndRead(false);
    } catch (error) {
        alert('Failed to run device: ' + (error.message || error));
    } finally {
        runButtons.forEach(btn => btn.disabled = false);
    }
}

// Parse a One ROM firmware image held in memory.
//
// Uses the same parser as readAndParseDevice, so the image and the device it is
// destined for are described by identical code and their fields are directly
// comparable - no normalisation between the two. It understands both firmware
// generations: v1 (Original) and v2 (Schema).
//
// An in-memory image has no live device behind it, so the RAM read callback
// rejects. The parser then treats the runtime as absent, exactly as it does for
// a stopped Fire or an Ice.
//
// Returns the parsed DeviceSummary, or null if the image could not be parsed.
async function parseFirmwareImage(fileArr) {
    // The parser lives in the WASM module, initialised once at page load. This
    // runs before any device contact, so it can be reached before that has
    // resolved. Awaited outside the try: a module that fails to load should
    // surface as itself, not as an unparseable image.
    await wasmReady;

    const readCb = () => Promise.reject(new Error('RAM unavailable: not a running device'));
    try {
        return await parse_firmware(new Uint8Array(fileArr), readCb);
    } catch (error) {
        console.warn('Firmware image parse failed:', error);
        return null;
    }
}

// Validate a firmware image before flashing it. Returns its parsed summary, so
// the caller can compare the image against the board without parsing twice.
//
// Version, corruption, board and MCU all come from the WASM parser, which
// understands both firmware generations. This previously hand-decoded the v1
// "SDRR" info struct at fixed offsets to get the MCU - which could only ever
// describe v1 firmware, and duplicated, less accurately, what the parser does.
//
// The one thing still read from the raw image is the Ice USB DFU support flag,
// which the parser does not surface - see assertIceImageSupportsUsb.
async function validateFirmware(fileArr, mcuVariant) {
    const summary = await parseFirmwareImage(fileArr);

    if (summary === null || !summary.version) {
        throw ("Error: Invalid One ROM .bin file (not recognisable One ROM firmware)");
    }

    // Parse errors mean we cannot trust anything the image says about itself,
    // including the board it is for - so it is not a basis for flashing.
    if (summary.corrupt) {
        throw ("Error: Invalid One ROM .bin file (" + summary.parse_errors.join('; ') + ")");
    }

    // MCU: the parser reports the variant for Ice (v1) and the family - always
    // RP2350 - for Fire (v2). Both forms are exactly what the tabs supply, so
    // this is a direct comparison.
    if (!summary.mcu) {
        throw ("Error: Invalid One ROM .bin file (firmware does not identify its MCU)");
    }

    if (summary.mcu !== mcuVariant) {
        throw ("Error: One ROM firmware is for wrong MCU variant (Firmware is for " +
                summary.mcu + ", expected " + mcuVariant + ")");
    }

    // Ice only: refuse an image built without USB DFU support. Flash one and the
    // board can only be recovered with the B0/3V3 jumper, so this is an error,
    // not a warning.
    //
    // This does not apply to Fire, where USB is a plugin: an image without one
    // simply drops to BOOTSEL when it sees VBUS, so the board stays manageable
    // and such an image is perfectly valid to flash.
    //
    // The board check cannot cover this. A USB-less image built for a USB Ice
    // board matches that board, so it would pass silently - and the board check
    // warns rather than blocks in any case.
    if ((summary.model || '').toLowerCase() === 'ice') {
        assertIceImageSupportsUsb(new Uint8Array(fileArr));
    }

    return summary;
}

// Verify a v1 (Ice) firmware image was built with USB DFU support.
//
// The flag is read directly from the image because it is not carried by
// DeviceSummary, and the device cannot answer for it either: what a board
// presents as describes the firmware being replaced, not the one going on.
//
// Layout, all little-endian:
//   0x200            v1 info struct, identified by an "SDRR" signature
//   0x200 + 0x38     pointer to extra_info, as a flash address
//   extra_info + 4   USB DFU support flag; 1 means supported
//
// Hardcoded offsets are normally a poor bet, but the v1 format is frozen - Ice
// is legacy and no further Ice firmware is expected - so there is nothing left
// to drift. The signature is checked first precisely because the offsets below
// are only meaningful if the struct really is where we think it is.
function assertIceImageSupportsUsb(view) {
    const INFO_BASE = 0x200;
    const EXTRA_INFO_PTR = INFO_BASE + 0x38;
    const STM32_FLASH_BASE = 0x08000000;
    const SIGNATURE = [0x53, 0x44, 0x52, 0x52];  // "SDRR"

    if (view.length < INFO_BASE + SIGNATURE.length) {
        throw ("Error: Invalid One ROM .bin file (too small to hold the info struct)");
    }

    for (let i = 0; i < SIGNATURE.length; i++) {
        if (view[INFO_BASE + i] !== SIGNATURE[i]) {
            throw ("Error: Invalid One ROM .bin file (missing \"SDRR\" signature at offset 0x200)");
        }
    }

    if (view.length < EXTRA_INFO_PTR + 4) {
        throw ("Error: Invalid One ROM .bin file (too small to hold an extra_info pointer)");
    }

    const pointer = view[EXTRA_INFO_PTR] |
                    (view[EXTRA_INFO_PTR + 1] << 8) |
                    (view[EXTRA_INFO_PTR + 2] << 16) |
                    (view[EXTRA_INFO_PTR + 3] << 24);

    // The pointer is a flash address; turn it into an offset within the image.
    const extraInfoOffset = pointer - STM32_FLASH_BASE;
    if (extraInfoOffset < 0 || extraInfoOffset + 5 > view.length) {
        throw ("Error: Invalid One ROM .bin file (extra_info pointer out of range: 0x" +
               (pointer >>> 0).toString(16) + ")");
    }

    if (view[extraInfoOffset + 4] !== 1) {
        throw ("Error: One ROM firmware provided does not support USB (Choose a firmware image that supports USB)");
    }
}

// The board revision is always the final component of the board name
// (fire-28-c -> C, fire-24-usb-b -> B), and is always silkscreened on the
// board, although it may be small and its form varies.
function boardRevisionLabel(boardName) {
    return boardName.split('-').pop().toUpperCase();
}

// Text for the case where the board and the image disagree about which board
// this is.
function boardMismatchMessage(boardHwRev, imageHwRev) {
    return 'Board mismatch\n\n' +
        'The firmware currently on this board says it is a ' + boardHwRev + ', ' +
        'but you are about to flash firmware for a ' + imageHwRev + '.\n\n' +
        'You probably only want to do this if this board was previously ' +
        'flashed with the wrong board\'s firmware, and you are now correcting ' +
        'that.\n\n' +
        'If you flash the wrong firmware you will have to de-brick One ROM ' +
        'before you can flash it again - see "How It Works" on this page for ' +
        'how.\n\n' +
        'Continue?';
}

// Text for the case where the board cannot tell us what it is. There is no
// hardware identity to read - a One ROM is only identifiable from the firmware
// already on it - so the user is asked to check the silkscreen instead.
function boardUnverifiableMessage(imageHwRev) {
    const rev = boardRevisionLabel(imageHwRev);
    return 'Board type cannot be checked\n\n' +
        'This board has no firmware on it, or none that can be read, and a ' +
        'One ROM can only be identified from the firmware already on it.\n\n' +
        'You are about to flash firmware for a ' + imageHwRev + ', so please ' +
        'check the board is marked "' + rev + '". The marking is silkscreened ' +
        'on the board, but may be small.\n\n' +
        'If you flash the wrong firmware you will have to de-brick One ROM ' +
        'before you can flash it again - see "How It Works" on this page for ' +
        'how.\n\n' +
        'Continue?';
}

// Confirm with the user before programming, when the board and the image
// disagree about which board this is - or when the board cannot tell us.
//
// Deliberately warn-and-allow, never block. Flashing an image for a different
// board is exactly what recovering a mis-flashed board looks like, so refusing
// would prevent the very repair this check exists to make less necessary. It
// follows that a mismatch cannot be reported as an error: the board may be the
// one lying, and we cannot tell the two cases apart.
//
// Returns true to proceed with programming, false if the user cancelled.
async function confirmBoardBeforeProgramming(imageSummary) {
    // With no board in the image there is nothing to compare, so there is no
    // basis on which to question the user. Should not arise for an image that
    // passed validateFirmware.
    if (!imageSummary.hw_rev) {
        console.warn('Image does not identify its board - skipping board check');
        return true;
    }

    // Re-read the board rather than trusting detectedDevice from Connect: the
    // user may have swapped boards since. readAndParseDevice leaves the page
    // alone, so this cannot disturb the user's selections mid-Program.
    const { summary } = await readAndParseDevice({
        onPhase: (phase) => dfuStatusHandler(phase)
    });

    // A board's identity is only knowable from the firmware on it. Blank flash,
    // an unparseable image, and firmware that records no board all mean the same
    // thing here: we cannot verify, so we ask the user to check the silkscreen
    // instead of telling them what they have.
    //
    // A parse that hit errors is NOT one of those cases. Errors are recorded
    // per section ("Hardware Revision", "ROM Sets", "Pins", ...), so a failure
    // in one says nothing about another: a board reporting fire-24-usb-b whose
    // ROM sets failed to parse has still told us what it is. hw_rev is present
    // precisely when its own section parsed, which makes it the right test -
    // requiring a clean parse threw away an identity we plainly had, and told
    // the user we could not name a board the panel above had just named.
    const boardKnown = summary !== null && !!summary.hw_rev;

    if (boardKnown && summary.hw_rev === imageSummary.hw_rev) {
        return true;
    }

    return confirm(boardKnown
        ? boardMismatchMessage(summary.hw_rev, imageSummary.hw_rev)
        : boardUnverifiableMessage(imageSummary.hw_rev));
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
        
            if (!CustomImageManager.hasCurrentBuild()) {
                throw ("Error: No firmware built for the current configuration - press Build Firmware");
            }
            
            fileArr = CustomImageManager.builtFirmware.buffer;
            mcuVariant = CustomImageManager.selectedMcu;
    
        } else {
            throw ("Error: No firmware source provided");
        }

        // Validate the incoming image before touching the device. Its parse is
        // kept: the board check below compares it against the board itself,
        // rather than parsing the same bytes twice.
        const imageSummary = await validateFirmware(fileArr, mcuVariant);

        // Connect to the device
        await dfu.connect(false);

        // Programming needs the bootloader, so stop the device if it is running
        // rather than sending the user away to press Stop themselves. Rebooting
        // re-enumerates it under a different PID, hence the reconnect.
        const wasRunning = dfu.isRunMode();
        if (wasRunning) {
            dfuStatusHandler('Stopping');
            if (!await dfu.rebootAndReconnect(true)) {
                // Cannot recover here: showing a picker needs user activation,
                // and this click's is long gone - retrieving and parsing the
                // image happened first. The board is stopped, so a Connect will
                // authorise the bootloader PID and the next Program is silent.
                throw ("Error: One ROM has been stopped, but cannot reconnect automatically.  " +
                       "Press Connect to re-connect manually, then Program again.");
            }
        }

        // Check the image is for this board, warning the user if not - or if
        // the board cannot say what it is. The user has the final word.
        if (!await confirmBoardBeforeProgramming(imageSummary)) {
            // The user has said no to this image, so do not leave it one click
            // from being flashed: discard it and make them build again. Only
            // the custom tab has anything to discard - the other tabs hold a
            // file or a selection, which cancelling does not invalidate.
            if (activeTab === 'custom') {
                CustomImageManager.discardBuild();
            }
            await dfu.disconnect();
            dfuDisconnectHandler();
            return;
        }

        // Run the update sequence (existing code)
        await dfu.runUpdateSequence(fileArr, mcuVariant);

        // Restart the One ROM if asked. Gated on the image we just flashed being
        // able to run: without a system plugin the firmware drops straight to
        // BOOTSEL the moment it sees VBUS, so rebooting into it would land us
        // back in the bootloader having achieved nothing.
        if (document.getElementById('restartAfterProgram').checked) {
            const imageModel = (imageSummary.model || '').toLowerCase();
            if (imageModel !== 'fire') {
                // Ice only ever presents in STM32 DFU bootloader mode, so it
                // cannot be told to run over USB at all - reboot() refuses it.
                // Its can_run reports the v1 USB DFU build flag, which says
                // nothing about running, so it cannot be used to decide this.
                console.log('Not restarting: only Fire can be restarted over USB');
            } else if (!imageSummary.can_run) {
                console.log('Not restarting: firmware has no system plugin, so it ' +
                            'cannot run while USB is attached');
            } else {
                dfuStatusHandler('Restarting');
                if (!await dfu.rebootAndReconnect(false)) {
                    // The reboot succeeded, so the device is running: only
                    // reattaching failed, which means the running PID has not
                    // been authorised on this origin yet. Programming is not in
                    // doubt, so report it as complete - but say plainly why the
                    // device panel has not refreshed, rather than letting the
                    // reconnect below fail with something vague.
                    setTimeout(() => alert('One ROM has been programmed and restarted, but ' +
                        'cannot reconnect automatically.  Press Connect to re-connect manually.'), 100);
                    dfuStatusHandler('Complete!');
                    setTimeout(() => {
                        dfuStatusHandler('Program');
                    }, 2000);
                    return;
                }
            }
        }

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

    // Bumped on every ROM file selection. Nothing about a file's name or length
    // distinguishes one selection from the next: rebuilding a ROM from source
    // produces the same filename, and ROM images are a fixed size, so both are
    // identical every time. Hashing the contents on each change event would
    // cost more than it is worth. The generation is exact and free - a fresh
    // selection is a new generation, whatever the bytes turn out to be.
    chipFileGeneration: 0,
    builtFirmware: null,

    // The configSignature() at the moment builtFirmware was produced. Any
    // difference from the current signature means the image is stale.
    builtFrom: null,

    // Last staleness reported to the console, so the diagnostic in
    // hasCurrentBuild() reports each change once rather than on every event.
    lastStaleLogged: null,
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
    // Plugin binaries fetched (and SHA-256 verified) up front by URL, so that
    // buildConfig can pick each plugin's size_handling from its actual length,
    // and the file-spec loop can reuse the bytes rather than fetching twice.
    // Populated per build by prefetchPlugins(); a Map<url, Uint8Array>.
    pluginBytes: null,
    // User INTENT (chosen plugin name; '' means None), tracked separately from
    // the <select> value so it survives repopulation on re-detect. See the
    // architectural notes at the top of this file. System defaults to USB.
    systemPluginIntent: 'usb',
    userPluginIntent: '',
    // User INTENT for the firmware version: the version the user explicitly
    // chose, or null if they have never picked one. Set only by a genuine
    // 'change' on the version select - the programmatic repopulate in
    // onMcuChange sets .value without dispatching 'change', so it never
    // touches this. onMcuChange re-applies it so an explicit choice survives
    // re-detects (e.g. after a flash) instead of snapping back to latest.
    versionIntent: null,
    
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
        document.getElementById('customVersionSelect').addEventListener('change', (e) => {
            // A genuine user pick. Record it as intent (null for the empty
            // placeholder) so it survives future repopulates in onMcuChange.
            this.versionIntent = e.target.value || null;
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

        // The MCU variant selector is redundant for Fire (always RP2350): the
        // single-MCU path in onPcbChange sets the value regardless, so the row
        // only adds noise. Hide it for Fire; Ice keeps it.
        this.showMcuRow(model);

        this.updateBuildButton();
    },
    
    async onPcbChange(boardName) {
        this.selectedBoard = boardName;
        
        // Get board info
        const boardInfo = this.wasm.board_info(boardName);
        const family = boardInfo.mcu_family;
        
        // Get MCUs for this family. RP2350B is excluded: One ROM uses both
        // RP2350A and RP2350B silicon, but they share the RP2350 firmware, so
        // offering B would be a distinction without a difference.
        const mcus = this.wasm.mcus_for_mcu_family(family)
            .filter(mcu => mcu.value !== 'RP2350B');

        // Populate MCU dropdown
        const mcuSelect = document.getElementById('customMcuSelect');
        mcuSelect.innerHTML = '<option value="">Select...</option>';
        mcus.forEach(mcu => {
            const option = document.createElement('option');
            option.value = mcu.value;
            option.textContent = mcu.pretty;
            mcuSelect.appendChild(option);
        });
        mcuSelect.disabled = false;

        // Auto-select the MCU when it is the only one on offer. This must test
        // the filtered list - the options the user can actually see - not the
        // raw list from the WASM. The Rp2350 family has two variants but only
        // one survives the filter, so testing the raw list never fired here and
        // Fire boards were left with an unselected MCU, and no version.
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
            
            // Re-apply the user's explicit version choice if they made one and
            // it is still offered - so it survives re-detects - otherwise
            // default to latest. versionIntent is null until a genuine user
            // change, so an untouched picker always lands on latest.
            if (this.versionIntent && compatible.includes(this.versionIntent)) {
                versionSelect.value = this.versionIntent;
            } else if (compatible.includes(data.latest)) {
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
            this.chipFileGeneration++;
            fileNameSpan.textContent = 'No file selected';
            fileNameSpan.classList.remove('selected');
            this.resetSelect('customRomTypeSelect');
            this.updateBuildButton();
            return;
        }
        
        this.chipFileName = file.name;
        this.chipFile = new Uint8Array(await file.arrayBuffer());
        this.chipFileGeneration++;

        // Clear the input now the bytes are safely in hand. A file input only
        // fires change when its value differs, and its value is the path - so
        // re-selecting the same file after rebuilding it from source fires
        // nothing, and the old contents stay silently in place. Clearing means
        // the next selection always fires, same path or not. Nothing else reads
        // this input's files; the filename is displayed from the captured File.
        e.target.value = '';

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
    
    // Hide the CS rows. Deliberately does NOT clear their values.
    //
    // Which rows are shown, and which values reach the config, are both decided
    // by the chip type's control_lines (see onRomTypeChange and buildConfig) -
    // never by what a dropdown happens to hold. A hidden row is exactly a row
    // buildConfig will not read, so leaving its value alone cannot affect a
    // build. It is simply remembered, and reappears if the user comes back to a
    // chip type that has that line.
    //
    // Clearing here used to lose the user's CS selections on every repopulate:
    // the auto-fill after a device read calls onModelChange (hides) and then
    // onRomTypeChange (hides, then re-shows), so the rows came back empty. That
    // also invalidated any built firmware, since CS is part of configSignature.
    hideCs() {
        ['customCs1Row', 'customCs2Row', 'customCs3Row'].forEach(id => {
            document.getElementById(id).classList.remove('visible');
        });
    },
    
    // A snapshot of every input the built firmware is derived from. Compared
    // against the snapshot taken at build time to tell whether the image in
    // hand still corresponds to what the form says - see hasCurrentBuild().
    //
    // Reads the controls directly rather than going via buildConfig(), which
    // assumes a complete, valid form and throws on a partial one. This runs on
    // every change event, valid or not.
    //
    // The plugins are identified by URL, not by the select value, because the
    // URL is what the build actually fetches and embeds. selectedBoard and
    // selectedMcu are omitted as they are just echoes of the pcb/mcu selects.
    configSignature() {
        const value = (id) => document.getElementById(id).value;
        const sizeHandling = document.querySelector('input[name="customSizeHandling"]:checked');

        return JSON.stringify({
            model: value('customModelSelect'),
            pcb: value('customPcbSelect'),
            mcu: value('customMcuSelect'),
            version: value('customVersionSelect'),
            romType: value('customRomTypeSelect'),
            sizeHandling: sizeHandling ? sizeHandling.value : '',
            cs: ['customCs1Select', 'customCs2Select', 'customCs3Select'].map(value),
            systemPlugin: this.selectedSystemPlugin ? this.selectedSystemPlugin.url : '',
            userPlugin: this.selectedUserPlugin ? this.selectedUserPlugin.url : '',
            // The generation, not the name or size, is what identifies the ROM
            // contents - see chipFileGeneration. The name is carried too, since
            // the build embeds it in the config.
            romFile: this.chipFileName,
            romFileGeneration: this.chipFileGeneration
        });
    },

    // Whether we hold a built image that still matches the form.
    //
    // Truthiness of builtFirmware is not enough: the form can move on after a
    // build - including when the code repopulates it after a device read - and
    // an image built from a different configuration must not be programmed or
    // saved as though it were the current one.
    hasCurrentBuild() {
        if (!this.builtFirmware) return false;
        if (this.builtFrom === this.configSignature()) return true;

        // Report what moved. Without this, a build going stale is indistinguishable
        // from the tool being broken - and the form can be changed by the code
        // itself (a device read repopulates it), not just by the user.
        const stale = this.staleFields().join(', ');
        if (stale !== this.lastStaleLogged) {
            console.log('Built firmware is stale - changed since build:', stale);
            this.lastStaleLogged = stale;
        }
        return false;
    },

    // Which parts of the configuration have moved since the build.
    staleFields() {
        if (!this.builtFrom) return [];
        const was = JSON.parse(this.builtFrom);
        const now = JSON.parse(this.configSignature());
        return Object.keys(now).filter(
            k => JSON.stringify(was[k]) !== JSON.stringify(now[k])
        );
    },

    // Throw away the built image, requiring a rebuild before it can be
    // programmed or saved again.
    discardBuild() {
        this.builtFirmware = null;
        this.builtFrom = null;
        document.getElementById('customSaveBtn').disabled = true;
        updateProgramButtonForCurrentTab();
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

        // A built image belongs to the form it was built from. Once the form
        // moves on the image is stale - neither programmable nor worth saving -
        // until it is rebuilt.
        document.getElementById('customSaveBtn').disabled = !this.hasCurrentBuild();
        updateProgramButtonForCurrentTab();
    },
    
    async buildFirmware() {
        const buildBtn = document.getElementById('customBuildBtn');
        buildBtn.disabled = true;
        buildBtn.textContent = 'Building...';
        
        try {
            // Fetch plugin binaries first: buildConfig needs each plugin's
            // actual length to choose its size_handling (see pluginChipSet).
            buildBtn.textContent = 'Fetching plugins...';
            await this.prefetchPlugins();

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
                    // Plugin: already fetched and verified by prefetchPlugins().
                    const bytes = this.pluginBytes.get(spec.source);
                    if (!bytes) {
                        throw new Error(`Plugin not pre-fetched: ${spec.source}`);
                    }
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
            this.builtFrom = this.configSignature();
            this.lastStaleLogged = null;
            
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
        if (!this.hasCurrentBuild()) return;

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

    // Show or hide the MCU variant row for the current model. Fire is always
    // RP2350, so the selector is redundant and hidden; the value is still set
    // by onPcbChange's single-MCU path. Ice keeps the row.
    showMcuRow(model) {
        document.getElementById('customMcuRow')
            .classList.toggle('hidden', model === 'Fire');
    },

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
        const bytes = this.pluginBytes.get(url);
        if (!bytes) {
            throw new Error(`Plugin not pre-fetched: ${url}`);
        }
        const size_handling = this.pluginSizeHandling(type, bytes.length);
        return { type: 'single', roms: [{ file: url, type, size_handling }] };
    },

    // Choose size_handling for a plugin binary. Plugins come from the
    // catalogue with a verified SHA-256, so the "wrong image" risk that pad's
    // strictness guards against does not apply here: a binary that exactly
    // fills the slot is legitimate. Pad when smaller than the slot; use none
    // when it exactly fills it (pad would reject a zero-length pad). A plugin
    // larger than its slot must never happen, so it is a hard error.
    pluginSizeHandling(type, length) {
        // chip_type_info() resolves names via ChipType::try_from_str, which
        // accepts a plugin's PascalCase key but not the snake_case form used
        // in the config (only serde deserialisation accepts the latter). Map
        // to the key it accepts so the slot size stays a real lookup.
        const chipType = { system_plugin: 'SystemPlugin', user_plugin: 'UserPlugin' }[type];
        if (!chipType) {
            throw new Error(`Unknown plugin type: ${type}`);
        }
        const slotSize = this.wasm.chip_type_info(chipType).size_bytes;
        if (length > slotSize) {
            throw new Error(
                `Plugin '${type}' is ${length} bytes, larger than its ` +
                `${slotSize}-byte slot`);
        }
        return length === slotSize ? 'none' : 'pad';
    },

    // Fetch and SHA-256 verify every selected plugin binary up front, caching
    // them by URL in this.pluginBytes. Done before buildConfig so size_handling
    // can be chosen from each plugin's real length, and so the later file-spec
    // loop reuses these bytes rather than fetching a second time.
    async prefetchPlugins() {
        this.pluginBytes = new Map();
        for (const plugin of [this.selectedSystemPlugin, this.selectedUserPlugin]) {
            if (plugin) {
                const bytes = await this.fetchAndVerifyPlugin(plugin.url);
                this.pluginBytes.set(plugin.url, bytes);
            }
        }
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
    // Run mode is no longer a bar to programming: startUpdate stops the device
    // itself, and restarts it afterwards if asked.
    const activeTab = document.querySelector('.tab-button.active').getAttribute('data-tab');
    
    if (activeTab === 'url') {
        connectProgramButton.disabled = !isUrlTabReady();
    } else if (activeTab === 'file') {
        connectProgramButton.disabled = !isFileTabReady();
    } else if (activeTab === 'prebuilt') {
        connectProgramButton.disabled = !isPrebuiltTabReady();
    } else if (activeTab === 'custom') {
        connectProgramButton.disabled = !CustomImageManager.hasCurrentBuild();
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

// Move the Programming Options block into the given tab.
//
// The block applies to every tab, but has to appear inside whichever one is
// showing to read sensibly. Rather than duplicating it per tab - four controls
// to keep in step, and four ids to choose between when programming - the single
// element is moved into that tab's anchor. Its state therefore cannot drift
// between tabs, because there is only one of it.
function showProgrammingOptionsInTab(targetTab) {
    const options = document.getElementById('programmingOptions');
    const anchor = document.querySelector(
        `.programming-options-anchor[data-tab="${targetTab}"]`);
    if (anchor && options) {
        anchor.appendChild(options);
    }
}

// Handle tab switching
tabButtons.forEach(button => {
    button.addEventListener('click', function() {
        const targetTab = this.getAttribute('data-tab');
        
        // Update button states
        tabButtons.forEach(btn => btn.classList.remove('active'));
        this.classList.add('active');

        showProgrammingOptionsInTab(targetTab);
        
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

        showProgrammingOptionsInTab(activeTab);

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

// Read the board's current firmware from flash and parse it.
//
// Deliberately free of page side effects: it touches neither the DOM nor
// detectedDevice, and so does not repopulate the programming tabs. That makes
// it safe to call mid-Program, where a repopulate would discard the user's
// selections (see the architectural notes at the top of this file). Callers
// that want to display the result do so themselves.
//
// Phase changes ('Reading', 'Re-reading') are reported through onPhase so each
// caller can route them to its own control. Upload progress is not handled
// here: it goes to window.dfuProgressHandler, which the caller owns.
//
// Returns { summary, firmwareData }:
//   - summary        the parsed DeviceSummary, or null if the flash contents
//                    could not be parsed at all
//   - firmwareData   the raw flash read, always present
//
// Throws ONLY if the flash could not be read (USB/transport failure). Flash
// that reads fine but cannot be interpreted is reported as a null summary, so
// callers can tell "I could not talk to the board" apart from "the board is
// not running firmware I understand" - a distinction they act on differently.
async function readAndParseDevice({ onPhase = () => {} } = {}) {
    onPhase('Reading');

    // Read the first 64KB of flash. Metadata - and therefore the plugin/ROM
    // list - lives within this range for both firmware generations.
    let firmwareData = await dfu.upload(65536);

    // RAM read callback handed to parse_firmware. The parser calls it to
    // follow runtime pointers into RAM, which is what lets us report the
    // active ROM. Only a running Fire has live runtime info, so for anything
    // else (a stopped Fire in the bootloader, or an Ice device, which is
    // never running) we reject immediately, rather than reading and
    // misinterpreting stale RAM.
    //
    // Rejecting is not an error: both parsers log the failed read and carry on
    // with no runtime, so the device simply shows as stopped with nothing
    // marked active. It does not make the parse corrupt.
    const canReadRam = dfu.getDeviceType() === 'Fire' && dfu.isRunMode();
    const readCb = canReadRam
        ? (addr, len) => dfu.readMemory(addr, len)
        : () => Promise.reject(new Error('RAM unavailable: device not running'));

    // Parse the flash image; RAM is fetched on demand through readCb. A parse
    // error means unrecognisable contents, not a failure to read, so it is
    // contained here rather than thrown.
    const tryParse = async (data) => {
        try {
            return await parse_firmware(data, readCb);
        } catch (error) {
            console.warn('Firmware parse failed:', error);
            return null;
        }
    };

    let summary = await tryParse(firmwareData);
    if (summary === null) return { summary: null, firmwareData };

    // Pre-v0.5.0 firmware read from a partial dump parses with errors. The
    // WASM reports the full chip size to re-read; do so and re-parse. An upload
    // failure here is still a read failure and propagates.
    if (summary.full_reread_size) {
        onPhase('Re-reading');
        console.log('Pre-v0.5.0 firmware: re-reading full chip for complete info');
        firmwareData = await dfu.upload(summary.full_reread_size);
        summary = await tryParse(firmwareData);
    }

    return { summary, firmwareData };
}

// Render the device summary for a board whose firmware we cannot interpret:
// everything but the status line is unknown, and the details pane is hidden
// because there is nothing to put in it.
function displayUninterpretableFirmware(status) {
    document.getElementById('deviceStatus').textContent = status;
    document.getElementById('deviceVersion').textContent = 'Unknown';
    document.getElementById('deviceMcu').textContent = 'Unknown';
    document.getElementById('deviceConfig').textContent = 'N/A';
    document.getElementById('devicePcbRevision').textContent = 'Unknown';
    document.getElementById('devicePluginsRow').classList.add('hidden');
    document.getElementById('deviceSummary').classList.remove('hidden');
    document.getElementById('deviceDetailsContent').textContent = '';
    document.getElementById('deviceDetails').classList.add('hidden');
}

async function readAndDisplayDeviceInfo() {
    // Save the original progress handler
    const originalProgressHandler = window.dfuProgressHandler;

    // Temporarily replace it to use the connect progress bar
    window.dfuProgressHandler = function(value) {
        connectProgressBar.value = value;
    };

    try {
        const { summary, firmwareData } = await readAndParseDevice({
            onPhase: (phase) => { connectBtn.textContent = phase; }
        });

        // Flash read, but the contents could not be parsed at all.
        if (summary === null) {
            displayUninterpretableFirmware('✘ - Unrecognized firmware');
            updateDeviceButtons();
            return;
        }

        // No version means this is not recognisable One ROM firmware. Tell a
        // blank (all-0xFF) chip apart from unrecognised contents.
        if (!summary.version) {
            const allFF = firmwareData.every(byte => byte === 0xFF);
            displayUninterpretableFirmware(allFF
                ? '✘ - No firmware (blank/erased chip)'
                : '✘ - Unrecognized firmware');
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

        // Store for pre-population of the programming tabs. canRun comes straight
        // from the WASM (has the USB system plugin) rather than being re-derived
        // here.
        //
        // Not gated on a clean parse: errors are recorded per section, so a
        // device whose ROM sets failed to parse can still have reported its
        // board and MCU perfectly well. Refusing to pre-populate on any error
        // left such a device's tabs on their defaults - pointing the user at
        // the wrong board. Each field is used only when it is present, which is
        // the same test.
        detectedDevice = {
            model: (summary.model || '').toLowerCase() || null,
            hw_rev: summary.hw_rev || null,
            mcu: summary.mcu || null,
            canRun: summary.can_run,
        };
        applyDetectedDeviceToPrebuilt();
        applyDetectedDeviceToCustom();

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

        updateDeviceButtons();
    } finally {
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