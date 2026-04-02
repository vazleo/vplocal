// ==UserScript==
// @name         VPLocal
// @namespace    https://github.com/vazleo/vplocal
// @version      0.2.2
// @description  Download VPL test cases and run them locally — stop overloading the jail server.
// @author       vazleo
// @match        *://*/mod/vpl/*
// @match        *://*/moodle/mod/vpl/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @connect      *
// @updateURL    https://raw.githubusercontent.com/vazleo/vplocal/main/userscript/vplocal.user.js
// @downloadURL  https://raw.githubusercontent.com/vazleo/vplocal/main/userscript/vplocal.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @resource     RUNNER https://raw.githubusercontent.com/vazleo/vplocal/main/runner/run_tests.py
// ==/UserScript==

/* ============================================================
 * VPLocal — Tampermonkey userscript
 *
 * Adds a "⬇ VPLocal" button to the VPL IDE page.
 * When clicked, it:
 *   1. Tries to fetch vpl_evaluate.cases via the Moodle API (Strategy A)
 *   2. Falls back to reconstructing cases from the captured WebSocket
 *      evaluation stream (Strategy B — requires one prior Evaluate click)
 *   3. Falls back to fetching the last saved evaluation result (Strategy C)
 *   4. Falls back to a manual paste dialog (Strategy D)
 * Then downloads a ZIP with the student's source files, the cases file,
 * and run_tests.py for local BIOTES-compatible testing.
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // INTERCEPTOR — must run at document-start before page scripts
  // ============================================================

  const OrigWS = unsafeWindow.WebSocket;
  const _capturedFrames = [];
  const _capturedStreams = {};

  function _recordFrame(url, data) {
    _capturedFrames.push({ url, data, ts: Date.now() });
    if (!_capturedStreams[url]) _capturedStreams[url] = [];
    _capturedStreams[url].push(data);
  }

  function VPLocalWebSocket(url, protocols) {
    console.log("[VPLocal] WebSocket intercepted:", url);
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener("message", (e) => { console.log("[VPLocal] frame from", url, e.data?.slice?.(0,80)); _recordFrame(url, e.data); });
    ws.addEventListener("close", () => {
      window.dispatchEvent(new CustomEvent("vplocal:stream-complete", {
        detail: { url, frames: _capturedStreams[url] || [] },
      }));
    });
    return ws;
  }
  VPLocalWebSocket.prototype = OrigWS.prototype;
  VPLocalWebSocket.CONNECTING = OrigWS.CONNECTING;
  VPLocalWebSocket.OPEN = OrigWS.OPEN;
  VPLocalWebSocket.CLOSING = OrigWS.CLOSING;
  VPLocalWebSocket.CLOSED = OrigWS.CLOSED;
  Object.defineProperty(VPLocalWebSocket, "name", { value: "WebSocket" });
  unsafeWindow.WebSocket = VPLocalWebSocket;

  unsafeWindow.__vplocalCapture = {
    getFrames: () => _capturedFrames.slice(),
    getStreams: () => Object.assign({}, _capturedStreams),
    clear: () => {
      _capturedFrames.length = 0;
      Object.keys(_capturedStreams).forEach((k) => delete _capturedStreams[k]);
    },
  };

  // ============================================================
  // Rest of the script runs after DOM is ready
  // ============================================================

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  onReady(function () {

    // ----------------------------------------------------------
    // EXTRACTOR
    // ----------------------------------------------------------
    function stripAnsi(str) {
      return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
    }

    function parseEvaluationStream(rawText) {
      const text = stripAnsi(rawText);
      const lines = text.split(/\r?\n/);
      const COMMENT_PREFIX = "Comment:=>>";
      const GRADE_PREFIX = "Grade:=>>";

      const commentLines = [];
      let grade = null;

      for (const line of lines) {
        if (line.startsWith(COMMENT_PREFIX)) {
          commentLines.push(line.slice(COMMENT_PREFIX.length).trimStart());
        } else if (line.startsWith(GRADE_PREFIX)) {
          const g = parseFloat(line.slice(GRADE_PREFIX.length).trim());
          if (!isNaN(g)) grade = g;
        }
      }
      // If no Comment:=>> prefix found, the text is already processed — use lines directly
      if (commentLines.length === 0) {
        for (const line of lines) commentLines.push(line);
      }

      const cases = [];
      let current = null;
      let section = null;

      function pushCurrent() {
        if (!current) return;
        if (current.input) current.input = current.input.replace(/\n+$/, "");
        if (current.expected) current.expected = current.expected.replace(/\n+$/, "");
        if (current.obtained) current.obtained = current.obtained.replace(/\n+$/, "");
        cases.push(current);
        current = null; section = null;
      }

      for (const line of commentLines) {
        const caseMatch = line.match(/^-*\s*Case\s*:\s*(.*)$/i)
                       || line.match(/^Case\s+(\d+)/i)
                       || line.match(/^Test\s+(\d+)\s*:\s*(.*)$/i);
        if (caseMatch) {
          pushCurrent();
          const desc = (caseMatch[2] || caseMatch[1] || "").trim();
          current = { description: desc, input: "", expected: "", obtained: "", source: "reconstructed" };
          section = null;
          continue;
        }
        if (!current) continue;
        if (/^-*\s*Input\s*-*\s*$/i.test(line))                          { section = "input";    continue; }
        if (/^-*\s*Expected\s+output[^-]*-*\s*$/i.test(line))             { section = "expected"; continue; }
        if (/^-*\s*(Obtained|Program)\s+output[^-]*-*\s*$/i.test(line))   { section = "obtained"; continue; }
        if (/^(Not\s+match|Match|OK|Fail|Incorrect|Correct)/i.test(line)) { section = null; continue; }

        if (section === "input")    current.input    += (current.input    ? "\n" : "") + line;
        if (section === "expected") current.expected += (current.expected ? "\n" : "") + line;
        if (section === "obtained") current.obtained += (current.obtained ? "\n" : "") + line;
      }
      pushCurrent();
      return { cases, grade };
    }

    function toCasesFileText(evalResult) {
      return evalResult.cases
        .filter((c) => c.expected)
        .map((c) => [
          `case = ${c.description || "Reconstructed case"}`,
          `input = ${c.input || ""}`,
          `output = ${c.expected}`,
          "",
        ].join("\n"))
        .join("\n");
    }

    function extractFromCapture() {
      const capture = unsafeWindow.__vplocalCapture;
      if (!capture) return null;
      const streams = capture.getStreams();
      let best = null, bestCount = 0;
      for (const url of Object.keys(streams)) {
        const raw = streams[url].map((f) => (typeof f === "string" ? f : "")).join("");
        const looksLikeEval = raw.includes("Comment:=>>") || raw.includes("Grade:=>>")
                           || /Test\s+\d+\s*:/i.test(raw) || /Case\s*:/i.test(raw);
        if (!looksLikeEval) continue;
        console.log("[VPLocal] Strategy B: captured stream from", url, "length", raw.length);
        const result = parseEvaluationStream(raw);
        if (result.cases.length > bestCount) { bestCount = result.cases.length; best = result; }
      }
      if (!best || bestCount === 0) return null;
      return { casesText: toCasesFileText(best), caseCount: bestCount, grade: best.grade };
    }

    // ----------------------------------------------------------
    // API CLIENT
    // ----------------------------------------------------------
    function getMoodleBase() {
      const url = new URL(window.location.href);
      const m = url.pathname.match(/^(.*?)\/mod\//);
      return m ? url.origin + m[1] : url.origin;
    }

    function getSesskey() {
      try {
        const cfg = unsafeWindow.M && unsafeWindow.M.cfg;
        if (cfg && cfg.sesskey) return cfg.sesskey;
      } catch {}
      const input = document.querySelector('input[name="sesskey"]');
      if (input) return input.value;
      for (const s of document.querySelectorAll("script")) {
        const m = s.textContent.match(/"sesskey"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
      return null;
    }

    function getCmid() {
      return new URLSearchParams(window.location.search).get("id") || null;
    }

    function gmFetch(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET", url, timeout: 15000,
          onload: (r) => resolve(r),
          onerror: (e) => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    async function fetchVplData() {
      const base = getMoodleBase();
      const sesskey = getSesskey();
      const cmid = getCmid();
      if (!sesskey) throw new Error("Could not find Moodle sesskey.");
      if (!cmid) throw new Error("Could not find VPL activity ID.");

      const url = `${base}/webservice/rest/server.php?wsfunction=mod_vpl_open&wstoken=${encodeURIComponent(sesskey)}&moodlewsrestformat=json&id=${encodeURIComponent(cmid)}`;
      const resp = await gmFetch(url);
      const data = JSON.parse(resp.responseText);
      if (data.exception) throw new Error(data.message || data.exception);

      const files = (data.files || []).map((f) => ({
        name: f.name,
        data: f.encoding === 1 ? atob(f.data) : f.data,
      }));

      const casesFile = files.find((f) => f.name === "vpl_evaluate.cases" || f.name === "evaluate.cases");
      const HIDDEN = new Set(["vpl_evaluate.cases", "evaluate.cases", "vpl_evaluate.sh", "vpl_debug.sh"]);
      return {
        casesText: casesFile ? casesFile.data : null,
        sourceFiles: files.filter((f) => !HIDDEN.has(f.name)),
      };
    }

    async function fetchLastResult() {
      const base = getMoodleBase();
      const sesskey = getSesskey();
      const cmid = getCmid();
      if (!sesskey || !cmid) return null;
      try {
        const url = `${base}/webservice/rest/server.php?wsfunction=mod_vpl_get_result&wstoken=${encodeURIComponent(sesskey)}&moodlewsrestformat=json&id=${encodeURIComponent(cmid)}`;
        const resp = await gmFetch(url);
        const data = JSON.parse(resp.responseText);
        return data.comments || null;
      } catch { return null; }
    }

    // ----------------------------------------------------------
    // PACKAGER
    // ----------------------------------------------------------
    function slugify(str) {
      return str.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "assignment";
    }

    function detectLang(sourceFiles) {
      for (const f of sourceFiles) {
        if (f.name.endsWith(".c")) return "c";
        if (f.name.endsWith(".cpp") || f.name.endsWith(".cxx")) return "cpp";
        if (f.name.endsWith(".py")) return "python";
        if (f.name.endsWith(".java")) return "java";
      }
      return null;
    }

    function generateReadme(assignmentName, casesText, coverage, lang) {
      const n = (casesText.match(/^case\s*=/gim) || []).length;
      const lines = [
        `# VPLocal — ${assignmentName}`,
        "",
        "## Quick Start",
        "```bash",
        "python3 run_tests.py",
        "```",
        "",
        `Run only case 3: \`python3 run_tests.py --case 3\``,
        "",
        "## Coverage",
        "",
        coverage.fetched      ? `- **${coverage.fetched}** case(s) fetched from server` : null,
        coverage.reconstructed ? `- **${coverage.reconstructed}** case(s) reconstructed from evaluation stream\n  *(only failed cases — passed cases not included)*` : null,
        coverage.manual        ? `- **${coverage.manual}** case(s) entered manually` : null,
        "",
        `Detected language: **${lang || "auto"}**`,
        "",
        "---",
        "*Generated by [VPLocal](https://github.com/vazleo/vplocal)*",
      ].filter((l) => l !== null);
      return lines.join("\n") + "\n";
    }

    async function buildAndDownload({ assignmentName, casesText, sourceFiles, runnerSource, coverage }) {
      if (typeof JSZip === "undefined") throw new Error("JSZip not loaded.");
      const lang = detectLang(sourceFiles);
      const slug = slugify(assignmentName);
      const folder = `vplocal_${slug}`;
      const zip = new JSZip();
      const dir = zip.folder(folder);
      for (const f of sourceFiles) dir.file(f.name, f.data);
      dir.file("vpl_evaluate.cases", casesText || "");
      if (runnerSource) dir.file("run_tests.py", runnerSource);
      dir.file("README.md", generateReadme(assignmentName, casesText || "", coverage, lang));

      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${folder}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
    }

    // ----------------------------------------------------------
    // UI
    // ----------------------------------------------------------
    let statusEl = null;
    let btn = null;

    function setStatus(msg, type) {
      if (!statusEl) return;
      const colors = { info: "#4a9eff", ok: "#4caf50", warn: "#ff9800", error: "#f44336" };
      statusEl.textContent = msg;
      statusEl.style.color = colors[type] || colors.info;
      statusEl.style.display = "inline";
    }

    function getAssignmentName() {
      const h = document.querySelector(".page-header-headings h1, h1.h2, .activityname");
      return h ? h.textContent.trim() : (document.title.replace(/ ?[-|] ?Moodle/, "").trim() || "assignment");
    }

    function showManualDialog(onConfirm) {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;";
      overlay.innerHTML = `
        <div style="background:#1e1e2e;color:#cdd6f4;border-radius:8px;padding:24px;width:600px;max-width:90vw;font-family:monospace;border:1px solid #45475a;">
          <h3 style="margin:0 0 12px;font-size:16px;color:#89b4fa;">VPLocal — Paste test cases</h3>
          <p style="margin:0 0 12px;font-size:13px;color:#a6adc8;">No cases captured automatically. Paste <code>vpl_evaluate.cases</code> content:</p>
          <textarea id="vpl-manual" style="width:100%;height:200px;background:#11111b;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;padding:8px;font-family:monospace;font-size:13px;box-sizing:border-box;" placeholder="case = Example&#10;input = 5 3&#10;output = 8"></textarea>
          <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
            <button id="vpl-cancel" style="padding:6px 14px;background:#313244;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
            <button id="vpl-confirm" style="padding:6px 14px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">Download ZIP</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#vpl-cancel").onclick = () => document.body.removeChild(overlay);
      overlay.querySelector("#vpl-confirm").onclick = () => {
        const text = overlay.querySelector("#vpl-manual").value.trim();
        document.body.removeChild(overlay);
        if (text) onConfirm(text);
      };
      overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    }

    async function onDownloadClick() {
      if (btn) { btn.disabled = true; btn.textContent = "⏳ Working…"; }

      // Load runner source (bundled via @resource, or inline fallback)
      let runnerSource = "";
      try { runnerSource = GM_getResourceText("RUNNER"); } catch {}

      try {
        let casesText = null;
        let sourceFiles = [];
        let coverage = { fetched: 0, reconstructed: 0, manual: 0 };

        // Strategy A
        setStatus("Fetching from Moodle API…", "info");
        try {
          const res = await fetchVplData();
          sourceFiles = res.sourceFiles;
          if (res.casesText) {
            casesText = res.casesText;
            coverage.fetched = (casesText.match(/^case\s*=/gim) || []).length;
            setStatus(`✓ ${coverage.fetched} case(s) from server`, "ok");
          }
        } catch (e) {
          console.warn("[VPLocal] Strategy A:", e.message);
          // Still try to get source files
          if (!sourceFiles.length) {
            setStatus("API unavailable, trying WebSocket capture…", "warn");
          }
        }

        // Strategy B
        if (!casesText) {
          const extracted = extractFromCapture();
          if (extracted && extracted.casesText) {
            casesText = extracted.casesText;
            coverage.reconstructed = extracted.caseCount;
            setStatus(`✓ ${coverage.reconstructed} case(s) from evaluation stream`, "ok");
          }
        }

        // Strategy C
        if (!casesText) {
          setStatus("Trying saved result…", "info");
          const saved = await fetchLastResult();
          if (saved) {
            const parsed = parseEvaluationStream(saved);
            const text = toCasesFileText(parsed);
            if (text.trim()) {
              casesText = text;
              coverage.reconstructed = parsed.cases.length;
              setStatus(`✓ ${coverage.reconstructed} case(s) from saved result`, "ok");
            }
          }
        }

        // Strategy D
        if (!casesText) {
          setStatus("Click 'Evaluate' once in VPL, then try again — or paste cases manually.", "warn");
          showManualDialog(async (text) => {
            coverage.manual = (text.match(/^case\s*=/gim) || []).length;
            await buildAndDownload({ assignmentName: getAssignmentName(), casesText: text, sourceFiles, runnerSource, coverage });
            setStatus("✓ Downloaded!", "ok");
          });
          if (btn) { btn.disabled = false; btn.textContent = "⬇ VPLocal"; }
          return;
        }

        await buildAndDownload({ assignmentName: getAssignmentName(), casesText, sourceFiles, runnerSource, coverage });
        setStatus("✓ Downloaded! Run: python3 run_tests.py", "ok");
      } catch (err) {
        setStatus("Error: " + err.message, "error");
        console.error("[VPLocal]", err);
      }
      if (btn) { btn.disabled = false; btn.textContent = "⬇ VPLocal"; }
    }

    // Inject button into VPL IDE toolbar (waits for dynamic render)
    function injectButton() {
      const SELECTORS = [
        "#vpl_ide_mexecution",
        ".vpl_ide_toolbar", "#vpl_ide_toolbar",
        '[id*="vpl"][class*="toolbar"]', ".vpl-ide-actions",
      ];

      function tryInject() {
        if (document.getElementById("vplocal-btn")) return true;

        for (const sel of SELECTORS) {
          const toolbar = document.querySelector(sel);
          if (toolbar) { insertNear(toolbar, true); return true; }
        }
        // fallback: find any VPL action button
        const vplEl = document.querySelector('[id="vpl_ide_evaluate"],[id="vpl_ide_run"],[id^="vpl_evaluate"],[id^="vpl_run"]');
        if (vplEl) { insertNear(vplEl.parentNode || vplEl, false); return true; }
        return false;
      }

      function insertNear(container, append) {
        btn = document.createElement("button");
        btn.id = "vplocal-btn";
        btn.textContent = "⬇ VPLocal";
        btn.title = "Download VPL test cases for local testing";
        btn.style.cssText = "margin-left:8px;padding:4px 10px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;";
        btn.onmouseover = () => { btn.style.background = "#2d7dd2"; };
        btn.onmouseout  = () => { btn.style.background = "#4a9eff"; };
        btn.onclick = onDownloadClick;

        statusEl = document.createElement("span");
        statusEl.id = "vplocal-status";
        statusEl.style.cssText = "margin-left:8px;font-size:12px;font-style:italic;display:none;";

        if (append) {
          container.appendChild(btn);
          container.appendChild(statusEl);
        } else {
          container.insertBefore(statusEl, container.firstChild);
          container.insertBefore(btn, container.firstChild);
        }
      }

      if (tryInject()) return;
      const observer = new MutationObserver(() => { if (tryInject()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 20000);
    }

    injectButton();

  }); // onReady

})();
