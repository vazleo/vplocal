/**
 * ui.js
 *
 * Injects the VPLocal button and status panel into the VPL IDE toolbar.
 * Orchestrates the download flow: Strategy A → B → D.
 */

const VPLocalUI = (function () {
  "use strict";

  let statusPanel = null;
  let downloadBtn = null;

  // ---------------------------------------------------------------------------
  // Status helpers
  // ---------------------------------------------------------------------------

  function setStatus(msg, type = "info") {
    if (!statusPanel) return;
    const colors = { info: "#4a9eff", ok: "#4caf50", warn: "#ff9800", error: "#f44336" };
    statusPanel.textContent = msg;
    statusPanel.style.color = colors[type] || colors.info;
    statusPanel.style.display = "block";
  }

  function clearStatus() {
    if (!statusPanel) return;
    statusPanel.style.display = "none";
  }

  // ---------------------------------------------------------------------------
  // Manual paste dialog (Strategy D fallback)
  // ---------------------------------------------------------------------------

  function showManualPasteDialog(onConfirm) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7); z-index: 99999;
      display: flex; align-items: center; justify-content: center;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      background: #1e1e2e; color: #cdd6f4; border-radius: 8px;
      padding: 24px; width: 600px; max-width: 90vw; font-family: monospace;
      border: 1px solid #45475a; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;

    dialog.innerHTML = `
      <h3 style="margin:0 0 12px; font-size:16px; color:#89b4fa;">
        VPLocal — Paste test cases manually
      </h3>
      <p style="margin:0 0 12px; font-size:13px; color:#a6adc8;">
        No test cases were captured automatically.<br>
        If you have access to the <code>vpl_evaluate.cases</code> content, paste it below.
      </p>
      <textarea id="vplocal-manual-input" style="
        width: 100%; height: 220px; background: #11111b; color: #cdd6f4;
        border: 1px solid #45475a; border-radius: 4px; padding: 8px;
        font-family: monospace; font-size: 13px; box-sizing: border-box; resize: vertical;
      " placeholder="case = Example&#10;input = 5 3&#10;output = 8"></textarea>
      <div style="margin-top: 12px; display:flex; gap:8px; justify-content:flex-end;">
        <button id="vplocal-cancel-btn" style="
          padding: 8px 16px; background: #313244; color: #cdd6f4;
          border: none; border-radius: 4px; cursor: pointer;
        ">Cancel</button>
        <button id="vplocal-confirm-btn" style="
          padding: 8px 16px; background: #89b4fa; color: #1e1e2e;
          border: none; border-radius: 4px; cursor: pointer; font-weight: bold;
        ">Download ZIP</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector("#vplocal-cancel-btn").onclick = () => {
      document.body.removeChild(overlay);
    };

    dialog.querySelector("#vplocal-confirm-btn").onclick = () => {
      const text = dialog.querySelector("#vplocal-manual-input").value.trim();
      document.body.removeChild(overlay);
      if (text) onConfirm(text, "manual");
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) document.body.removeChild(overlay);
    };
  }

  // ---------------------------------------------------------------------------
  // Main download flow
  // ---------------------------------------------------------------------------

  async function handleDownloadClick(runnerSource) {
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.textContent = "⏳ Working…";
    }

    try {
      let casesText = null;
      let sourceFiles = [];
      let coverage = { fetched: 0, reconstructed: 0, manual: 0 };

      // ---- Strategy A: try the Moodle API directly ----
      setStatus("Fetching files from Moodle…", "info");
      try {
        const result = await VPLocalAPI.fetchVplData();
        sourceFiles = result.sourceFiles || [];

        if (result.casesText) {
          casesText = result.casesText;
          coverage.fetched = (casesText.match(/^case\s*=/gim) || []).length;
          setStatus(`Strategy A: found ${coverage.fetched} case(s) directly!`, "ok");
        }
      } catch (err) {
        setStatus("API fetch failed, trying WebSocket capture…", "warn");
        console.warn("[VPLocal] Strategy A failed:", err.message);
      }

      // ---- Strategy B: check WebSocket capture ----
      if (!casesText) {
        const extracted = VPLocalExtractor.extractFromCapture();
        if (extracted && extracted.casesText) {
          casesText = extracted.casesText;
          coverage.reconstructed = extracted.caseCount;
          setStatus(`Strategy B: reconstructed ${coverage.reconstructed} case(s) from evaluation stream.`, "ok");
        }
      }

      // ---- Strategy C: fetch saved result ----
      if (!casesText) {
        setStatus("Trying saved evaluation result…", "info");
        try {
          const savedComments = await VPLocalAPI.fetchLastResult();
          if (savedComments && savedComments.includes("Comment:=>>")) {
            const parsed = VPLocalExtractor.parseEvaluationStream(savedComments);
            const text = VPLocalExtractor.toCasesFileText(parsed);
            if (text.trim()) {
              casesText = text;
              coverage.reconstructed = parsed.cases.length;
              setStatus(`Strategy C: reconstructed ${coverage.reconstructed} case(s) from saved result.`, "ok");
            }
          }
        } catch (err) {
          console.warn("[VPLocal] Strategy C failed:", err.message);
        }
      }

      // ---- Strategy D: manual paste ----
      if (!casesText) {
        setStatus("No cases found automatically — manual paste required.", "warn");
        showManualPasteDialog(async (text, src) => {
          coverage.manual = (text.match(/^case\s*=/gim) || []).length;
          await finalizeDownload(text, sourceFiles, coverage, runnerSource);
        });
        if (downloadBtn) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = "⬇ VPLocal";
        }
        return;
      }

      await finalizeDownload(casesText, sourceFiles, coverage, runnerSource);
    } catch (err) {
      setStatus("Error: " + err.message, "error");
      console.error("[VPLocal]", err);
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = "⬇ VPLocal";
      }
    }
  }

  async function finalizeDownload(casesText, sourceFiles, coverage, runnerSource) {
    const assignmentName = getAssignmentName();
    setStatus("Building ZIP…", "info");

    await VPLocalPackager.buildAndDownload({
      assignmentName,
      casesText,
      sourceFiles,
      runnerSource,
      coverage,
    });

    setStatus("Downloaded! Run: python3 run_tests.py", "ok");
    if (downloadBtn) {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "⬇ VPLocal";
    }
  }

  function getAssignmentName() {
    // Try page title or VPL activity name from the DOM
    const heading = document.querySelector(".page-header-headings h1, h1.h2, .activityname");
    if (heading) return heading.textContent.trim();
    return document.title.replace(" - Moodle", "").trim() || "assignment";
  }

  // ---------------------------------------------------------------------------
  // Button injection
  // ---------------------------------------------------------------------------

  /**
   * Wait for the VPL IDE toolbar to appear, then inject the button.
   * VPL renders the IDE dynamically via JS, so we use a MutationObserver.
   */
  function inject(runnerSource) {
    const TOOLBAR_SELECTORS = [
      ".vpl_ide_toolbar",
      "#vpl_ide_toolbar",
      '[id*="vpl"][class*="toolbar"]',
      ".vpl-ide-actions",
    ];

    function tryInject() {
      for (const sel of TOOLBAR_SELECTORS) {
        const toolbar = document.querySelector(sel);
        if (toolbar && !document.getElementById("vplocal-btn")) {
          injectInto(toolbar, runnerSource);
          return true;
        }
      }
      // Fallback: look for the VPL action buttons by their known IDs
      const vplRun = document.getElementById("vpl_run") || document.querySelector('[id^="vpl_evaluate"], [id^="vpl_run"]');
      if (vplRun && !document.getElementById("vplocal-btn")) {
        injectNearElement(vplRun, runnerSource);
        return true;
      }
      return false;
    }

    if (tryInject()) return;

    // VPL loads its IDE asynchronously — observe for DOM changes
    const observer = new MutationObserver(() => {
      if (tryInject()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Timeout fallback after 15s
    setTimeout(() => observer.disconnect(), 15000);
  }

  function createButton(runnerSource) {
    const btn = document.createElement("button");
    btn.id = "vplocal-btn";
    btn.textContent = "⬇ VPLocal";
    btn.title = "Download test cases for local testing";
    btn.style.cssText = `
      margin-left: 8px; padding: 4px 10px;
      background: #4a9eff; color: #fff; border: none;
      border-radius: 4px; cursor: pointer; font-size: 13px;
      font-family: inherit; font-weight: 600;
    `;
    btn.onmouseover = () => { btn.style.background = "#2d7dd2"; };
    btn.onmouseout  = () => { btn.style.background = "#4a9eff"; };
    btn.onclick = () => handleDownloadClick(runnerSource);
    downloadBtn = btn;

    const status = document.createElement("span");
    status.id = "vplocal-status";
    status.style.cssText = `
      margin-left: 8px; font-size: 12px; font-style: italic; display: none;
    `;
    statusPanel = status;

    return { btn, status };
  }

  function injectInto(toolbar, runnerSource) {
    const { btn, status } = createButton(runnerSource);
    toolbar.appendChild(btn);
    toolbar.appendChild(status);
  }

  function injectNearElement(el, runnerSource) {
    const { btn, status } = createButton(runnerSource);
    el.parentNode.insertBefore(btn, el.nextSibling);
    el.parentNode.insertBefore(status, btn.nextSibling);
  }

  return { inject };
})();
