import { test, expect, describe, beforeEach } from "bun:test";
import { Window } from "happy-dom";

// ---------------------------------------------------------------------------
// Setup a fresh happy-dom environment with mocked htmx globals.
// Must run BEFORE dynamic import of client.ts so `declare var htmx: any`
// resolves to our mock rather than HTMX 2.x UMD which doesn't set window.htmx.
//
// Strategy: each test group creates its OWN fresh env in a beforeEach so the
// DOM and htmx mock are clean before init() runs. Bun caches modules, so
// initMarkdownBlocks() is the same function across calls — but `declare var`
// references (document, window, htmx) resolve from globalThis at runtime,
// which we rewire each test.
// ---------------------------------------------------------------------------

function setupEnv() {
    const win = new Window({ settings: { disableJavaScriptEvaluation: true } });

    // happy-dom 20.x on Bun: internal SelectorParser needs built-in error
    // constructors on the Window instance for CSS selector parsing.
    win.SyntaxError = SyntaxError;
    win.TypeError = TypeError;
    win.ReferenceError = ReferenceError;
    win.RangeError = RangeError;

    // Minimal htmx mock — must exist as both globalThis.htmx and win.htmx
    const htmxMock = {
        _lastAjaxCall: null,
        ajax: function (...args) {
            htmxMock._lastAjaxCall = args;
            return Promise.resolve();
        },
        on: () => {},
    };

    // Wire globals from happy-dom Window to globalThis so the imported module sees them.
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Element = win.Element;
    globalThis.Node = win.Node;
    globalThis.MouseEvent = win.MouseEvent;
    globalThis.CustomEvent = win.CustomEvent;
    globalThis.HTMLElement = win.HTMLElement;
    globalThis.Event = win.Event;
    globalThis.setTimeout = win.setTimeout.bind(win);
    globalThis.clearTimeout = win.clearTimeout.bind(win);

    // Mock window.location.reload so afterBlockSwap doesn't reload the page
    Object.defineProperty(win, "location", {
        value: { href: "http://localhost/", reload: () => {} },
        writable: true,
        configurable: true,
    });
    Object.defineProperty(win, "innerWidth", {
        value: 1280,
        writable: true,
        configurable: true,
    });

    // Critical: set htmx as a real (writable) global variable.
    Object.defineProperty(globalThis, "htmx", {
        value: htmxMock,
        writable: true,
        configurable: true,
        enumerable: true,
    });
    win.htmx = htmxMock;

    return { win, htmx: htmxMock };
}

// ---------------------------------------------------------------------------
// Query helpers on the happy-dom document
// ---------------------------------------------------------------------------

function q(sel) {
    return globalThis.document.querySelector(sel);
}

function qa(sel) {
    return Array.from(globalThis.document.querySelectorAll(sel));
}

function clickOn(target, opts = {}) {
    const event = new globalThis.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...opts,
    });
    target.dispatchEvent(event);
    return event;
}

// ---------------------------------------------------------------------------
// Lazy import of client module (cached by Bun after first call)
// ---------------------------------------------------------------------------

let initMarkdownBlocks: (() => void) | null = null;
async function getInit() {
    if (!initMarkdownBlocks) {
        const mod = await import("../src/client.js");
        initMarkdownBlocks = mod.initMarkdownBlocks;
    }
    return initMarkdownBlocks!;
}

// ---------------------------------------------------------------------------
// Tests — save indicator & global flag
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — save indicator", () => {
    beforeEach(() => setupEnv());

    test("creates #save-indicator div in body with text 'Saved'", async () => {
        const init = await getInit();
        init();
        expect(q("#save-indicator")).not.toBeNull();
        expect(q("#save-indicator")?.textContent).toBe("Saved");
    });

 });

// ---------------------------------------------------------------------------
// Tests — click delegation
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — click delegation", () => {
    beforeEach(() => setupEnv());

    test("click inside .mb-block adds .mb-editing and activates toolbar", async () => {
        const env = setupEnv();
        const block = env.win.document.createElement("div");
        block.className = "mb-block";
        block.innerHTML = '<div class="mb-bar">Edit</div><p>content</p>';
        globalThis.document.body.appendChild(block);

        (await getInit())();
        clickOn(block.querySelector("p"));

        expect(block.classList.contains("mb-editing")).toBe(true);
        expect(block.querySelector(".mb-bar").classList.contains("active")).toBe(
            true,
        );
    });

    test("click on second block removes .mb-editing from first block", async () => {
        const env = setupEnv();
        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block mb-editing";
        blockA.innerHTML = '<div class="mb-bar active">Edit</div><p>content A</p>';
        globalThis.document.body.appendChild(blockA);

        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.innerHTML = '<div class="mb-bar">Edit</div><p>content B</p>';
        globalThis.document.body.appendChild(blockB);

        (await getInit())();
        clickOn(blockB.querySelector("p"));

        // When clicking a new block, .mb-editing is removed from all other blocks
        expect(blockA.classList.contains("mb-editing")).toBe(false);
        expect(blockB.classList.contains("mb-editing")).toBe(true);
        // blockB's bar gets .active
        expect(blockB.querySelector(".mb-bar").classList.contains("active")).toBe(true);
    });

    test("click outside any block deactivates all toolbars and removes floaters", async () => {
        const env = setupEnv();
        const block = env.win.document.createElement("div");
        block.className = "mb-block mb-editing";
        block.innerHTML = '<div class="mb-bar active">Edit</div><p>content</p>';
        globalThis.document.body.appendChild(block);

        const floater = env.win.document.createElement("div");
        floater.className = "mb-floater";
        globalThis.document.body.appendChild(floater);

        const outside = env.win.document.createElement("div");
        outside.id = "outside-area";
        outside.textContent = "click me";
        globalThis.document.body.appendChild(outside);

        (await getInit())();
        clickOn(outside);

        expect(block.classList.contains("mb-editing")).toBe(false);
        expect(
            block.querySelector(".mb-bar").classList.contains("active"),
        ).toBe(false);
        expect(qa(".mb-floater").length).toBe(0);
    });

    test("click outside any block triggers auto-save for editing blocks", async () => {
        const env = setupEnv();

        // Block A: currently being edited (has .mb-source)
        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block mb-editing";
        blockA.setAttribute("data-block-id", "p-0");
        blockA.innerHTML = `
            <textarea class="mb-source">Edited content</textarea>
            <input type="hidden" name="path" value="/page/"
        `;
        globalThis.document.body.appendChild(blockA);

        // Block B: just rendered (no textarea)
        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.innerHTML = '<p>Other block</p>';
        globalThis.document.body.appendChild(blockB);

        // Floater for block A
        const floater = env.win.document.createElement("div");
        floater.className = "mb-floater";
        globalThis.document.body.appendChild(floater);

        (await getInit())();

        // Click outside any block
        const outside = env.win.document.createElement("div");
        outside.id = "outside-area";
        globalThis.document.body.appendChild(outside);
        clickOn(outside);

        // Verify htmx.ajax was called to save Block A
        expect(env.htmx._lastAjaxCall).not.toBeNull();
        const [method, pathArg, config] = env.htmx._lastAjaxCall;
        expect(method).toBe("POST");
        expect(pathArg).toBe("/save");
        expect(config.values.text).toBe("Edited content");
    });

    test("click inside .mb-bar is ignored (capture phase early return)", async () => {
        const env = setupEnv();
        const block = env.win.document.createElement("div");
        block.className = "mb-block";
        block.innerHTML = '<div class="mb-bar"><button>Save</button></div><p>content</p>';
        globalThis.document.body.appendChild(block);

        (await getInit())();
        clickOn(block.querySelector(".mb-bar")!);

        expect(block.classList.contains("mb-editing")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests — htmx:afterSwap listener (per-block, attached at init time)
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — htmx:afterSwap listener", () => {
    beforeEach(() => setupEnv());

    test("afterBlockSwap creates floater and adds .mb-editing when /source swap returns .mb-edit + .mb-source", async () => {
        const env = setupEnv();

        // Block that exists BEFORE init so the htmx:afterSwap listener is attached
        const block = env.win.document.createElement("div");
        block.className = "mb-block";
        block.setAttribute("data-block-id", "h1-0");
        block.innerHTML = `<h1 class="mb-content">Title</h1>
            <div class="mb-bar" data-mb-block-id="h1-0"><button>Save</button></div>`;
        env.win.document.body.appendChild(block);

        (await getInit())();

        // Simulate server response from GET /source: .mb-edit wrapper with .mb-source textarea
        // and action bar. The afterSwap listener checks for .mb-edit to enter edit mode.
        block.innerHTML = `
            <div class="mb-edit">
                <textarea class="mb-source" autofocus># Title</textarea>
            </div>
            <div class="mb-bar" data-mb-block-id="h1-0"><button>Save</button></div>
        `;

        // Dispatch htmx:afterSwap — HTMX 2.x dispatches on target element directly
        const swapEvent = new env.win.CustomEvent("htmx:afterSwap", {
            bubbles: false,
        });
        block.dispatchEvent(swapEvent);

        expect(block.classList.contains("mb-editing")).toBe(true);
        expect(globalThis.document.querySelector(".mb-floater")).not.toBeNull();
        // Bar should have been moved into floater (not in block anymore)
        expect(block.querySelector(".mb-bar")).toBeNull();
    });

    test("afterBlockSwap exits edit mode when /save swap returns rendered HTML (no .mb-edit/.mb-source)", async () => {
        const env = setupEnv();

        const block = env.win.document.createElement("div");
        block.className = "mb-block mb-editing";
        block.setAttribute("data-block-id", "h1-0");
        block.innerHTML = `<div class="mb-edit"><textarea class="mb-source"># Title</textarea></div>`;
        env.win.document.body.appendChild(block);

        const floater = env.win.document.createElement("div");
        floater.className = "mb-floater";
        floater.innerHTML = '<div class="mb-bar">Save</div>';
        env.win.document.body.appendChild(floater);

        (await getInit())();

        // Simulate /save response: content replaced back to rendered HTML (no .mb-edit)
        block.innerHTML = "<h1>Title</h1>";

        const swapEvent = new env.win.CustomEvent("htmx:afterSwap", {
            bubbles: false,
        });
        block.dispatchEvent(swapEvent);

        // Also fire htmx:afterRequest to trigger orphaned-floater cleanup
        // Create a dummy button for afterRequest handler (needs detail.elt with data-mb-block-id)
        const dummyBtn = env.win.document.createElement('button');
        dummyBtn.setAttribute('data-mb-block-id', 'h1-0');
        const afterReqEvent = new env.win.CustomEvent("htmx:afterRequest", {
            detail: { elt: dummyBtn, pathInfo: { requestPath: "/save" }, xhr: { status: 200 } },
            bubbles: true,
        });
        document.body.dispatchEvent(afterReqEvent);

        expect(block.classList.contains("mb-editing")).toBe(false);
        expect(globalThis.document.querySelector(".mb-floater")).toBeNull();
    }); // end test: exits edit mode
}); // end describe: htmx:afterSwap listener

// ---------------------------------------------------------------------------
// Tests — auto-save via htmx.ajax (triggered by afterBlockSwap)
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — auto-save via htmx.ajax", () => {
    beforeEach(() => setupEnv());

    test("auto-saves previous block when switching to a new block's /source response", async () => {
        const env = setupEnv();

        // Block A: currently being edited (has .mb-source textarea with value)
        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block";
        blockA.setAttribute("data-block-id", "p-0");
        blockA.innerHTML = `
            <textarea class="mb-source">Edited paragraph text</textarea>
            <input type="hidden" name="path" value="/page/" />
        `;
        env.win.document.body.appendChild(blockA);

        // Block B: will receive htmx:afterSwap (just loaded source, entering edit)
        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.setAttribute("data-block-id", "h2-0");
        blockB.innerHTML = `<h2 class="mb-content">Subtitle</h2>
            <div class="mb-bar" data-mb-block-id="h2-0"><button>Save</button></div>`;
        env.win.document.body.appendChild(blockB);

        (await getInit())();

        // Simulate /source response on Block B — now has .mb-edit wrapper with .mb-source
        blockB.innerHTML = `
            <div class="mb-edit">
                <textarea class="mb-source">## Subtitle</textarea>
            </div>
            <div class="mb-bar" data-mb-block-id="h2-0"><button>Save</button></div>
        `;

        const swapEvent = new env.win.CustomEvent("htmx:afterSwap", {
            bubbles: false,
        });
        blockB.dispatchEvent(swapEvent);

        // Verify htmx.ajax was called with correct values to save Block A's content
        expect(env.htmx._lastAjaxCall).not.toBeNull();
        const [method, pathArg, config] = env.htmx._lastAjaxCall;
        expect(method).toBe("POST");
        expect(pathArg).toBe("/save");
        expect(config.headers["HX-Request"]).toBe("true");
        expect(config.values.action).toBe("edit");
        expect(config.values.blockId).toBe("p-0");
        expect(config.values.path).toBe("/page/");
        expect(config.values.text).toBe("Edited paragraph text");
        expect(config.swap).toBe("innerHTML");
        expect(config.target).toBe(blockA);
    });

    test("auto-save uses default path '/' when no hidden input found", async () => {
        const env = setupEnv();

        // Block with .mb-source but NO path input
        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block";
        blockA.setAttribute("data-block-id", "p-0");
        blockA.innerHTML = `<textarea class="mb-source">Some text</textarea>`;
        env.win.document.body.appendChild(blockA);

        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.setAttribute("data-block-id", "h1-0");
        blockB.innerHTML = `<h1 class="mb-content">Title</h1>
            <div class="mb-bar" data-mb-block-id="h1-0"><button>Save</button></div>`;
        env.win.document.body.appendChild(blockB);

        (await getInit())();

        // Simulate /source response on Block B
        blockB.innerHTML = `
            <div class="mb-edit">
                <textarea class="mb-source"># Title</textarea>
            </div>
            <div class="mb-bar" data-mb-block-id="h1-0"><button>Save</button></div>
        `;

        const swapEvent = new env.win.CustomEvent("htmx:afterSwap", {
            bubbles: false,
        });
        blockB.dispatchEvent(swapEvent);

        const [, , config] = env.htmx._lastAjaxCall;
        expect(config.values.path).toBe("/");
    });
});

// ---------------------------------------------------------------------------
// Tests — htmx:beforeRequest listener (target resolution)
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — htmx:beforeRequest listener", () => {
    beforeEach(() => setupEnv());

    test("resolves data-mb-block-id on trigger element to .mb-block targetOverride", async () => {
        const env = setupEnv();

        const block = env.win.document.createElement("div");
        block.className = "mb-block";
        block.setAttribute("data-block-id", "h1-0");
        env.win.document.body.appendChild(block);

        (await getInit())();

        const triggerEl = env.win.document.createElement("button");
        triggerEl.setAttribute("data-mb-block-id", "h1-0");

        const evt = new env.win.CustomEvent("htmx:beforeRequest", {
            detail: { elt: triggerEl },
            bubbles: true,
        });

        env.win.document.body.dispatchEvent(evt);

        expect(evt.detail.targetOverride).toBe(block);
    });

    test("does nothing if matching .mb-block is not found", async () => {
        const env = setupEnv();
        (await getInit())();

        const triggerEl = env.win.document.createElement("button");
        triggerEl.setAttribute("data-mb-block-id", "nonexistent-99");

        const evt = new env.win.CustomEvent("htmx:beforeRequest", {
            detail: { elt: triggerEl },
            bubbles: true,
        });

        env.win.document.body.dispatchEvent(evt);

        expect(evt.detail.targetOverride).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Tests — htmx:afterRequest listener (DOM reorder + save indicator)
// ---------------------------------------------------------------------------

describe("initMarkdownBlocks — htmx:afterRequest listener (DOM reorder)", () => {
    beforeEach(() => setupEnv());

    test("move-down button reorders block after its next sibling", async () => {
        const env = setupEnv();

        const container = env.win.document.createElement("div");
        container.className = "container";

        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block";
        blockA.setAttribute("data-block-id", "h1-0");
        blockA.textContent = "First";

        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.setAttribute("data-block-id", "h1-1");
        blockB.textContent = "Second";

        container.appendChild(blockA);
        container.appendChild(blockB);
        env.win.document.body.appendChild(container);

        (await getInit())();

        const moveBtn = env.win.document.createElement("button");
        moveBtn.setAttribute("data-mb-block-id", "h1-0");
        moveBtn.setAttribute("data-mb-move", "down");

        const evt = new env.win.CustomEvent("htmx:afterRequest", {
            detail: { elt: moveBtn },
            bubbles: true,
        });
        env.win.document.body.dispatchEvent(evt);

        expect(container.children[0]).toBe(blockB);
        expect(container.children[1]).toBe(blockA);
    });

    test("move-up button reorders block before its previous sibling", async () => {
        const env = setupEnv();

        const container = env.win.document.createElement("div");
        container.className = "container";

        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block";
        blockA.setAttribute("data-block-id", "h1-0");
        blockA.textContent = "First";

        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.setAttribute("data-block-id", "h1-1");
        blockB.textContent = "Second";

        container.appendChild(blockA);
        container.appendChild(blockB);
        env.win.document.body.appendChild(container);

        (await getInit())();

        const moveBtn = env.win.document.createElement("button");
        moveBtn.setAttribute("data-mb-block-id", "h1-1");
        moveBtn.setAttribute("data-mb-move", "up");

        const evt = new env.win.CustomEvent("htmx:afterRequest", {
            detail: { elt: moveBtn },
            bubbles: true,
        });
        env.win.document.body.dispatchEvent(evt);

        expect(container.children[0]).toBe(blockB);
        expect(container.children[1]).toBe(blockA);
    });

    test("move at boundary — no reordering when no sibling in direction", async () => {
        const env = setupEnv();

        const container = env.win.document.createElement("div");

        const blockA = env.win.document.createElement("div");
        blockA.className = "mb-block";
        blockA.setAttribute("data-block-id", "h1-0");
        container.appendChild(blockA);

        const blockB = env.win.document.createElement("div");
        blockB.className = "mb-block";
        blockB.setAttribute("data-block-id", "h1-1");
        container.appendChild(blockB);

        env.win.document.body.appendChild(container);

        (await getInit())();

        const moveBtn = env.win.document.createElement("button");
        moveBtn.setAttribute("data-mb-block-id", "h1-0");
        moveBtn.setAttribute("data-mb-move", "up");

        const evt = new env.win.CustomEvent("htmx:afterRequest", {
            detail: { elt: moveBtn },
            bubbles: true,
        });
        env.win.document.body.dispatchEvent(evt);

        expect(container.children[0]).toBe(blockA);
        expect(container.children[1]).toBe(blockB);
    });
});

describe("initMarkdownBlocks — htmx:afterRequest save indicator", () => {
    beforeEach(() => setupEnv());

    test("shows save-indicator on /save 200 response", async () => {
        const env = setupEnv();
        (await getInit())();

        const indicator = globalThis.document.getElementById("save-indicator");
        expect(indicator).not.toBeNull();

        const evt = new env.win.CustomEvent("htmx:afterRequest", {
            detail: {
                elt: null,
                pathInfo: { requestPath: "/save" },
                xhr: { status: 200 },
            },
            bubbles: true,
        });

        env.win.document.body.dispatchEvent(evt);

        expect(indicator.classList.contains("show")).toBe(true);
    });

    test("does not show save-indicator for non-/save paths", async () => {
        const env = setupEnv();
        (await getInit())();

        const indicator = globalThis.document.getElementById("save-indicator");

        const evt = new env.win.CustomEvent("htmx:afterRequest", {
            detail: {
                elt: null,
                pathInfo: { requestPath: "/source" },
                xhr: { status: 200 },
            },
            bubbles: true,
        });

        env.win.document.body.dispatchEvent(evt);

        expect(indicator.classList.contains("show")).toBe(false);
    });
});
