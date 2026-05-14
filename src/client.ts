// @ts-nocheck — htmx is loaded via CDN at runtime; no import available.
declare var htmx: any;

/** Build and attach all HTMX client-side listeners for markdown-block editing. */
export function initMarkdownBlocks(): void {
    // -----------------------------------------------------------------------
    // Save indicator (rendered immediately so the element exists in DOM)
    // -----------------------------------------------------------------------
    const indicator = document.createElement('div');
    indicator.id = 'save-indicator';
    indicator.textContent = 'Saved';
    document.body.appendChild(indicator);

    // -----------------------------------------------------------------------
    // 1. Click delegation — manage .mb-editing class for toolbar visibility
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'click',
        (evt: MouseEvent) => {
            const target = evt.target as Node;

            // Ignore clicks inside toolbar — they have their own handlers
            if ((target as Element).closest('.mb-bar')) return;

            const block = (target as Element).closest('.mb-block');
            if (block) {
                // Exit edit mode on any other block
                document.querySelectorAll('.mb-block.mb-editing').forEach((b) => {
                    b.classList.remove('mb-editing');
                    // Deactivate toolbar on the previous editing block
                    const prevBar = b.querySelector('.mb-bar');
                    if (prevBar) prevBar.classList.remove('active');
                });
                // Remove stale floaters (they belong to the previous block)
                document.querySelectorAll('.mb-floater').forEach((f) => f.remove());
                block.classList.add('mb-editing');
                // Activate toolbar on newly clicked block
                const bar = block.querySelector('.mb-bar');
                if (bar) bar.classList.add('active');
            } else {
                // Click outside any block — auto-save editing blocks, then deactivate
                saveEditingBlocks();
                document.querySelectorAll('.mb-block.mb-editing').forEach((b) => {
                    b.classList.remove('mb-editing');
                    // Deactivate toolbar on every editing block
                    const prevBar = b.querySelector('.mb-bar');
                    if (prevBar) prevBar.classList.remove('active');
                });
                document.querySelectorAll('.mb-floater').forEach((f) => f.remove());
            }
        },
        true,
    );

    // -----------------------------------------------------------------------
    // 1b. Floater button delegation — HTMX 2.x click delegation bug:
    //     hx-post on <button> elements moved in the DOM after swap is not
    //     processed.  We dispatch imperative htmx.ajax() instead.
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'click',
        (evt: MouseEvent) => {
            const btn = (evt.target as Element).closest(
                '.mb-bar [data-mb-move], .mb-bar [data-mb-action]',
            ) as HTMLElement | null;
            if (!btn) return;

            const blockId = btn.getAttribute('data-mb-block-id');
            if (!blockId) return;

            // Derive page path from the associated .mb-block's .mb-content hx-vals
            // rather than hardcoding '/' — fixes subpage save routing.
            const blockEl = document.querySelector(
                '.mb-block[data-block-id="' + blockId + '"]',
            );
            const contentEl = blockEl?.querySelector('.mb-content');
            let pagePath = '/';
            if (contentEl) {
                try {
                    const hxVals = JSON.parse(contentEl.getAttribute('hx-vals') || '{}');
                    pagePath = hxVals.path ?? '/';
                } catch {}
            }

            const moveDir = btn.getAttribute('data-mb-move');
            if (moveDir === 'up' || moveDir === 'down') {
                evt.preventDefault();
                htmx.ajax('POST', '/save', {
                    source: btn,
                    values: {
                        action: 'move',
                        direction: moveDir,
                        blockId,
                        path: pagePath,
                    },
                    swap: 'none',
                });
                return;
            }

            const action = btn.getAttribute('data-mb-action');
            if (action === 'delete') {
                evt.preventDefault();
                htmx.ajax('POST', '/save', {
                    source: btn,
                    target: blockEl,
                    values: {
                        action: 'delete',
                        blockId,
                        path: pagePath,
                    },
                    swap: 'delete',
                });
                return;
            }
            if (action === 'insert') {
                evt.preventDefault();
                htmx.ajax('POST', '/save', {
                    source: btn,
                    target: blockEl,
                    values: {
                        action: 'insert',
                        afterBlockId: blockId,
                        tag: 'p',
                        text: '\u200B',
                        path: pagePath,
                    },
                    swap: 'afterend',
                });
                return;
            }
        },
        true,
    );

    // -----------------------------------------------------------------------
    // 3. htmx:afterRequest — move-DOM after reorder + floater cleanup
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'htmx:afterRequest',
        (evt: Event) => {
            const btn = (evt as CustomEvent).detail.elt;
            if (!btn) return;

            const blockId =
                btn.getAttribute('data-mb-block-id') ||
                (btn.closest('.mb-bar') &&
                    btn.closest('.mb-bar').getAttribute('data-mb-block-id'));

            const block = blockId
                ? document.querySelector(
                      '.mb-block[data-block-id="' + blockId + '"]',
                  )
                : null;
            if (!block) return;

            // Reorder block in DOM when move buttons trigger a save
            const moveDir = btn.getAttribute('data-mb-move');
            if (moveDir === 'up' || moveDir === 'down') {
                const dir = moveDir === 'up' ? 'prev' : 'next';
                const parent = block.parentNode;
                if (dir === 'prev' && block.previousElementSibling) {
                    parent.insertBefore(block, block.previousElementSibling);
                } else if (dir === 'next' && block.nextElementSibling) {
                    parent.insertBefore(block.nextElementSibling, block);
                }
            }

            // Handle action buttons: delete, insert
            const action = btn.getAttribute('data-mb-action');
            if (action === 'delete') {
                block.remove();
            } else if (action === 'insert') {
                setTimeout(() => {
                    const newBlockId = btn.getAttribute('data-mb-block-id');
                    const refBlock = document.querySelector('.mb-block[data-block-id="' + newBlockId + '"]');
                    const newBlock = refBlock?.nextElementSibling;
                    if (newBlock && newBlock.classList.contains('mb-block')) {
                        newBlock.querySelector('.mb-content')?.click();
                    }
                }, 100);
            }

            // Clean up orphaned floaters after any save request
            const floater = document.querySelector('.mb-floater');
            if (floater) {
                let hasLiveTarget = false;
                const bars = floater.querySelectorAll('[data-mb-block-id]');
                for (let i = 0; i < bars.length; i++) {
                    const bid = bars[i].getAttribute('data-mb-block-id');
                    if (bid && document.querySelector('.mb-block[data-block-id="' + bid + '"]')) {
                        hasLiveTarget = true;
                        break;
                    }
                }
                if (!hasLiveTarget) {
                    floater.remove();
                }
            }
        },
        true,
    );

    // -----------------------------------------------------------------------
    // 5. Body-level capture listener for htmx:afterSwap — handles edit-mode
    //    enter/exit for ANY block, including newly inserted ones
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'htmx:afterSwap',
        (evt: Event) => {
            const block = (evt.target as Element).closest
                ? (evt.target as Element).closest('.mb-block')
                : null;
            if (!block) return;

            const edit = block.querySelector('.mb-edit');
            const sourceWasNew = edit && !block.getAttribute('data-mb-source');
            if (sourceWasNew) {
                block.setAttribute('data-mb-source', '1');
                afterBlockSwap(block); // /source swap: enter edit mode
            } else if (!edit) {
                // /save swap: exit edit mode, clean up
                const oldEdit = block.querySelector('.mb-edit');
                if (oldEdit) oldEdit.remove();
                // Don't remove .mb-bar — it's part of the normal shell!
                block.classList.remove('mb-editing');
                block.removeAttribute('data-mb-source');
                // Global orphaned-floater cleanup is handled by htmx:afterRequest listener
            }
        },
        true, // capture phase
    );

    // -----------------------------------------------------------------------
    // 5b. htmx:beforeRequest — resolve data-mb-block-id to .mb-block target
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'htmx:beforeRequest',
        (evt: Event) => {
            const detail = (evt as CustomEvent).detail;
            const elt = detail.elt;
            if (!elt) return;

            const blockId = elt.getAttribute('data-mb-block-id');
            if (blockId) {
                const targetBlock = document.querySelector(
                    '.mb-block[data-block-id="' + blockId + '"]',
                );
                if (targetBlock) {
                    detail.targetOverride = targetBlock;
                }
            }
        },
        true, // capture phase
    );

    // -----------------------------------------------------------------------
    // 6. Save indicator display logic
    // -----------------------------------------------------------------------
    document.body.addEventListener(
        'htmx:afterRequest',
        (evt: Event) => {
            const detail = (evt as CustomEvent).detail;
            const path = detail.pathInfo?.requestPath;

            if (path && path.includes('/save') && detail.xhr.status === 200) {
                const el = document.getElementById('save-indicator');
                if (!el) return;
                el.classList.add('show');
                clearTimeout((el as any)._timer);
                (el as any)._timer = setTimeout(() => el.classList.remove('show'), 1500);
            }
        },
        true,
    );
}

// ---------------------------------------------------------------------------
// 3a. Auto-save helper — saves all editing blocks except one
// ---------------------------------------------------------------------------
function saveEditingBlocks(exceptBlock?: Element): void {
    const sources = document.querySelectorAll('.mb-source');
    for (let i = 0; i < sources.length; i++) {
        const srcBlock = sources[i].closest('.mb-block');
        if (srcBlock && srcBlock !== exceptBlock) {
            const blockId = srcBlock.getAttribute('data-block-id');
            const pathEl = srcBlock.querySelector('input[name="path"]');
            const p = pathEl ? pathEl.value : '/';
            const text = sources[i].value;

            const editDiv = srcBlock.querySelector('.mb-edit');
            htmx.ajax(
                'POST',
                '/save',
                {
                    headers: { 'HX-Request': 'true' },
                    values: { action: 'edit', blockId, path: p, text },
                    swap: 'innerHTML',
                    target: srcBlock,
                },
            );

            break; // Only save the first editing block
        }
    }
}

// ---------------------------------------------------------------------------
// 4. afterBlockSwap — auto-save previous block, focus/position textarea + floater
// ---------------------------------------------------------------------------
function afterBlockSwap(block: Element): void {
    block.classList.add('mb-editing');

    // Auto-save: if another block is being edited (has .mb-source), save it
    saveEditingBlocks(block);

  const source = block.querySelector('.mb-source');
    const bar = block.querySelector('.mb-bar');
    if (source && bar) {
        // Remove any existing floaters first to avoid orphans when switching blocks
        const existing = document.querySelector('.mb-floater');
        if (existing) existing.remove();

        // Move action bar into a floating overlay positioned above the block
        const floater = document.createElement('div');
        floater.className = 'mb-floater';
        document.body.appendChild(floater);
        floater.appendChild(bar.parentNode.removeChild(bar));
        const rect = block.getBoundingClientRect();
        floater.style.top = rect.top - 42 + 'px';
        floater.style.right = window.innerWidth - rect.right + 4 + 'px';
    }

    if (source) {
        source.focus();
        // Auto-size to content
        source.style.height = 'auto';
        source.style.height = source.scrollHeight + 'px';
    }
}

// Auto-initialize on load (module defers, DOM is ready, HTMX CDN already loaded)
initMarkdownBlocks();
