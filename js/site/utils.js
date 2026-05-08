// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

const SORT_WEIGHT_OVERRIDES = {
    '27C': {
        '256':   256,
        '512':   512,
        '010':  1024,
        '020':  2048,
        '040':  4096,
        '080':  8192,
        '301':  8192,
    },
    '28C': {
        '16':     16,
        '64':     64,
        '256':   256,
        '512':   512,
        '010':  1024,
        '020':  2048,
        '040':  4096,
        '080':  8192,
    },
};

function parseChipName(name) {
    if (/^[A-Za-z]/.test(name)) {
        const m = name.match(/^([A-Za-z]+)(.*)/);
        return { family: m[1], subfamily: '', suffix: m[2], isAlphaFamily: true };
    }
    const m = name.match(/^(\d{2})([A-Za-z]*)(\d*)/);
    if (m) {
        return { family: m[1], subfamily: m[2] || '', suffix: m[3] || '', isAlphaFamily: false };
    }
    return { family: name, subfamily: '', suffix: '', isAlphaFamily: false };
}

export function compareChips(a, b) {
    const pa = parseChipName(a);
    const pb = parseChipName(b);
    if (pa.isAlphaFamily !== pb.isAlphaFamily)
        return pa.isAlphaFamily ? 1 : -1;
    const familyCmp = pa.family.localeCompare(pb.family);
    if (familyCmp !== 0) return familyCmp;
    if (pa.isAlphaFamily)
        return pa.suffix.localeCompare(pb.suffix);
    const subfamilyCmp = pa.subfamily.localeCompare(pb.subfamily);
    if (subfamilyCmp !== 0) return subfamilyCmp;
    const overrideKey = pa.family + pa.subfamily;
    const overrides = SORT_WEIGHT_OVERRIDES[overrideKey];
    const wa = overrides?.[pa.suffix] ?? (parseInt(pa.suffix, 10) || 0);
    const wb = overrides?.[pb.suffix] ?? (parseInt(pb.suffix, 10) || 0);
    return wa - wb;
}