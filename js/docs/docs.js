// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Download and display the documentation PDFs.
//
// data-doc="all" renders every document in the index, for /docs/.
// data-doc="<slug>" renders one, for a product page carrying its own manual.
//
// Only the version named by each document's "latest" is offered.  Past editions
// stay published so an older build's manual remains fetchable, but a visitor
// looking at a download page wants the current one.

(async function() {
    const script = document.currentScript;
    const doc = script.dataset.doc;
    const placeholderId = script.dataset.target || 'docs-table';
    const sourcesId = script.dataset.sources || 'docs-sources';

    if (!doc) {
        console.error('docs.js: data-doc attribute is required');
        return;
    }

    const base = 'https://images.onerom.org/docs';

    const paperInfo = {
        a4: { label: 'PDF (A4)' },
        letter: { label: 'PDF (Letter)' }
    };

    const placeholder = document.getElementById(placeholderId);
    if (!placeholder) {
        console.error(`docs.js: no element with id '${placeholderId}'`);
        return;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // One row per paper size, matching the shape of the release tables.
    function renderReleaseRows(catalogue, slug) {
        const release = catalogue.releases.find(r => r.version === catalogue.latest);
        if (!release) return '';

        let rows = '';
        for (const file of release.files) {
            const info = paperInfo[file.paper];
            if (!info) continue;

            const url = `${base}/${slug}/${release.path}/${file.filename}`;
            const shortHash = file.sha256.substring(0, 8);

            rows += `
                <tr>
                    <td style="width: 1px; white-space: nowrap; padding-right: 12px; vertical-align: middle; text-align: center; color: var(--one-rom-gold);">${escapeHtml(catalogue.tracks_label)} v${escapeHtml(release.version)}</td>
                    <td style="padding-right: 12px; vertical-align: middle; text-align: center">
                        <a href="${url}" class="file-button" style="margin-top: 0; width: 150px; min-height: 3em; display: flex; align-items: center; justify-content: center;">${info.label}</a>
                    </td>
                    <td style="vertical-align: middle;">
                        <code><span style="cursor: pointer; font-size: 1.5em;" onclick="navigator.clipboard.writeText('${file.sha256}')" title="Copy">📋</span> sha256: ${shortHash}...</code>
                    </td>
                </tr>`;
        }

        if (!rows) return '';
        return `
            <table style="margin-top: 1rem; margin-left: auto; margin-right: auto; border-collapse: collapse;">
                ${rows}
            </table>`;
    }

    const repoBase = 'https://github.com/piersfinlayson/one-rom/blob/main';

    // A PDF may be assembled from several documents, so `sources` is a list in
    // every case and each entry gets its own link.
    function renderSourceRow(catalogue) {
        const sources = catalogue.sources;
        if (!Array.isArray(sources) || sources.length === 0) return '';
        const links = sources.map(path =>
            `<a href="${repoBase}/${path}" target="_blank"><code>${escapeHtml(path)}</code></a>`
        ).join(', ');
        return `
            <li>
                ${escapeHtml(catalogue.display_name)} &mdash; ${links}
            </li>`;
    }

    function renderSources(items) {
        const list = document.getElementById(sourcesId);
        if (!list) return;
        list.innerHTML = items ? `<ul>${items}</ul>` : '';
    }

    async function fetchCatalogue(path) {
        const response = await fetch(`${base}/${path}/releases.json`);
        if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
        return response.json();
    }

    try {
        if (doc === 'all') {
            const response = await fetch(`${base}/docs.json`);
            if (!response.ok) throw new Error(`${response.status} fetching docs.json`);
            const index = await response.json();

            let html = '';
            let sources = '';
            for (const document_ of index.documents) {
                let catalogue;
                try {
                    catalogue = await fetchCatalogue(document_.path);
                } catch (error) {
                    // A document listed but not yet published should not take
                    // the rest of the page down with it.
                    console.error('docs.js:', error);
                    continue;
                }

                const table = renderReleaseRows(catalogue, document_.path);
                if (!table) continue;

                html += `
                    <h3>${escapeHtml(catalogue.display_name || document_.title)}</h3>
                    <p>${escapeHtml(catalogue.description || '')}</p>
                    ${table}`;
                sources += renderSourceRow(catalogue);
            }

            placeholder.innerHTML = html || '<p>No documentation is published yet.</p>';

            renderSources(sources);
        } else {
            const catalogue = await fetchCatalogue(doc);
            const table = renderReleaseRows(catalogue, doc);
            placeholder.innerHTML = table || '<p>No published edition.</p>';
            renderSources(renderSourceRow(catalogue));
        }

    } catch (error) {
        console.error('Failed to load documentation:', error);
        placeholder.innerHTML = '<p>Failed to load documentation information.</p>';
    }
})();
