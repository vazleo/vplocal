/**
 * api.js
 *
 * Moodle / VPL REST API client.
 * Uses GM_xmlhttpRequest to bypass CORS — requires @grant GM_xmlhttpRequest
 * and @connect * in the userscript header.
 */

const VPLocalAPI = (function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Extract Moodle context info from the current page
  // ---------------------------------------------------------------------------

  function getMoodleBase() {
    // Works for any Moodle subpath, e.g. https://moodle.uni.edu/moodle/
    const url = new URL(window.location.href);
    // Find the path up to and including the segment before /mod/
    const match = url.pathname.match(/^(.*?)\/mod\//);
    if (match) {
      return url.origin + match[1];
    }
    return url.origin;
  }

  function getSesskey() {
    // Primary: Moodle JS config object (works across all Moodle versions)
    try {
      const cfg = unsafeWindow.M && unsafeWindow.M.cfg;
      if (cfg && cfg.sesskey) return cfg.sesskey;
    } catch {}

    // Fallback: hidden input in the page
    const input = document.querySelector('input[name="sesskey"]');
    if (input) return input.value;

    // Fallback: scan all script tags for sesskey assignment
    for (const script of document.querySelectorAll("script")) {
      const m = script.textContent.match(/"sesskey"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }

    return null;
  }

  function getCmid() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) return id;

    // Some VPL URLs embed it differently
    const m = window.location.pathname.match(/\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Raw GM_xmlhttpRequest wrapper (returns a Promise)
  // ---------------------------------------------------------------------------

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (resp) => resolve(resp),
        onerror: (err) => reject(new Error("Network error: " + JSON.stringify(err))),
        ontimeout: () => reject(new Error("Request timed out")),
        timeout: 15000,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // VPL Web Service calls
  // ---------------------------------------------------------------------------

  /**
   * Call mod_vpl_open — returns the student's own submitted files.
   * May include vpl_evaluate.cases if the professor didn't restrict it.
   */
  async function vplOpen(cmid, sesskey, base) {
    const url =
      `${base}/webservice/rest/server.php` +
      `?wsfunction=mod_vpl_open` +
      `&wstoken=${encodeURIComponent(sesskey)}` +
      `&moodlewsrestformat=json` +
      `&id=${encodeURIComponent(cmid)}`;

    const resp = await gmRequest({ method: "GET", url });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);

    let data;
    try {
      data = JSON.parse(resp.responseText);
    } catch {
      throw new Error("Invalid JSON response from mod_vpl_open");
    }

    if (data.exception) throw new Error(data.message || data.exception);
    return data; // { files: [{name, data, encoding}], ...}
  }

  /**
   * Call mod_vpl_get_result — returns the last evaluation result.
   */
  async function vplGetResult(cmid, sesskey, base) {
    const url =
      `${base}/webservice/rest/server.php` +
      `?wsfunction=mod_vpl_get_result` +
      `&wstoken=${encodeURIComponent(sesskey)}` +
      `&moodlewsrestformat=json` +
      `&id=${encodeURIComponent(cmid)}`;

    const resp = await gmRequest({ method: "GET", url });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);

    let data;
    try {
      data = JSON.parse(resp.responseText);
    } catch {
      throw new Error("Invalid JSON response from mod_vpl_get_result");
    }

    if (data.exception) throw new Error(data.message || data.exception);
    return data; // { grade, comments, ... }
  }

  // ---------------------------------------------------------------------------
  // High-level: try to get vpl_evaluate.cases via API (Strategy A)
  // ---------------------------------------------------------------------------

  /**
   * Returns { casesText, sourceFiles } or throws.
   * sourceFiles: [{ name, data }]
   */
  async function fetchVplData() {
    const base = getMoodleBase();
    const sesskey = getSesskey();
    const cmid = getCmid();

    if (!sesskey) throw new Error("Could not find Moodle sesskey on this page.");
    if (!cmid) throw new Error("Could not find VPL activity ID in URL.");

    const openResult = await vplOpen(cmid, sesskey, base);
    const files = openResult.files || [];

    // Decode files (VPL returns them base64 or plain depending on encoding field)
    const decoded = files.map((f) => ({
      name: f.name,
      data: f.encoding === 1 ? atob(f.data) : f.data,
    }));

    // Check for test cases file
    const casesFile = decoded.find(
      (f) =>
        f.name === "vpl_evaluate.cases" ||
        f.name === "evaluate.cases"
    );

    return {
      casesText: casesFile ? casesFile.data : null,
      sourceFiles: decoded.filter(
        (f) =>
          f.name !== "vpl_evaluate.cases" &&
          f.name !== "evaluate.cases" &&
          f.name !== "vpl_evaluate.sh"
      ),
    };
  }

  /**
   * Strategy C: fetch last saved result and extract its comment block.
   * Returns raw comment text for the extractor to parse.
   */
  async function fetchLastResult() {
    const base = getMoodleBase();
    const sesskey = getSesskey();
    const cmid = getCmid();

    if (!sesskey || !cmid) return null;

    try {
      const result = await vplGetResult(cmid, sesskey, base);
      return result.comments || null;
    } catch {
      return null;
    }
  }

  return { fetchVplData, fetchLastResult, getSesskey, getCmid, getMoodleBase };
})();
