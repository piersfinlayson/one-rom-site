// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Download and display the releases table

(async function() {
    try {
        const response = await fetch('https://images.onerom.org/studio/releases.json');
        const manifest = await response.json();
        
        // Map targets to display info
        const targetInfo = {
            'x86_64-pc-windows-msvc': {
                logo: 'images/win.svg',
                logoAlt: 'Windows Logo',
                label: 'Windows x86<br>64-bit'
            },
            'universal-apple-darwin': {
                logo: 'images/apple.svg',
                logoAlt: 'Apple Logo',
                label: 'macOS'
            },
            'x86_64-unknown-linux-gnu': {
                logo: 'images/Tux.svg',
                logoAlt: 'Tux',
                label: 'Ubuntu/Debian<br>x86 64-bit'
            },
            'aarch64-unknown-linux-gnu': {
                logo: 'images/Tux.svg',
                logoAlt: 'Tux',
                label: 'Ubuntu/Debian/Pi<br>ARM 64-bit'
            }
        };
        
        // Build rows
        const targets = [
            'x86_64-pc-windows-msvc',
            'universal-apple-darwin',
            'x86_64-unknown-linux-gnu',
            'aarch64-unknown-linux-gnu'
        ];
        
        let rows = '';
        let needsTopPadding = false;
        
        for (const target of targets) {
            const version = manifest.latest[target];
            const release = manifest.releases.find(r => r.version === version);
            if (!release) continue;
            
            const platform = release.platforms.find(p => p.target === target);
            if (!platform) continue;
            
            const info = targetInfo[target];
            const url = `https://images.onerom.org/studio/${release.path}/${platform.filename}`;
            const shortHash = platform.sha256.substring(0, 8);
            
            // Add separator before each row except the first
            if (rows) {
                rows += `
                <tr>
                    <td colspan="4" style="padding: 1rem 0.5rem;"><hr style="margin: 0;"></td>
                </tr>`;
            }
            
            const paddingStyle = needsTopPadding ? ' padding-top: 0.75rem;' : '';
            needsTopPadding = (target === 'x86_64-apple-darwin' || target === 'aarch64-unknown-linux-gnu');
            
            rows += `
                <tr>
                    <td style="width: 48px; padding-right: 12px;${paddingStyle} vertical-align: middle;">
                        <img src="${info.logo}" alt="${info.logoAlt}" style="width: 36px; height: 36px;">
                    </td>
                    <td style="width: 1px; padding-right: 12px;${paddingStyle} vertical-align: middle; text-align: center; color: var(--one-rom-gold);">V${version}</td>
                    <td style="padding-right: 12px;${paddingStyle} vertical-align: middle; text-align: center">
                        <a href="${url}" class="file-button" style="margin-top: 0; width: 150px; display: inline-block; min-height: 3em; display: flex; align-items: center; justify-content: center;">${info.label}</a>
                    </td>
                    <td style="${paddingStyle} vertical-align: middle;">
                        <code><span style="cursor: pointer; font-size: 1.5em;" onclick="navigator.clipboard.writeText('${platform.sha256}')" title="Copy">📋</span> sha256: ${shortHash}...</code>
                    </td>
                </tr>`;
        }
        
        // Build complete table
        const table = `
            <table style="margin-top: 1.5rem; margin-left: auto; margin-right: auto; border-collapse: collapse;">
                ${rows}
            </table>`;
        
        // Insert into placeholder
        const placeholder = document.getElementById('downloads-table');
        if (placeholder) {
            placeholder.innerHTML = table;
        }
        
    } catch (error) {
        console.error('Failed to load releases:', error);
    }
})();