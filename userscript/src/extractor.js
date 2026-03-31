/**
 * extractor.js
 *
 * Parses VPL jail server evaluation output streams to reconstruct
 * vpl_evaluate.cases content from the Comment:=>> blocks.
 *
 * BIOTES default output format for a failed case:
 *   Comment:=>> Case: <description>
 *   Comment:=>> Input:
 *   Comment:=>> <input lines...>
 *   Comment:=>> Expected output:
 *   Comment:=>> <expected lines...>
 *   Comment:=>> Obtained output:
 *   Comment:=>> <obtained lines...>
 *   Comment:=>> Not match
 *
 * Grade line (always present at end):
 *   Grade:=>> <number>
 *
 * The format may vary between BIOTES versions and custom evaluators,
 * so the parser is intentionally lenient.
 */

const VPLocalExtractor = (function () {
  "use strict";

  // Strip ANSI escape codes
  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
  }

  // Join all captured frames for a stream into one string
  function joinFrames(frames) {
    return frames.map((f) => (typeof f === "string" ? f : "")).join("");
  }

  /**
   * Parse the evaluation output stream and extract test cases.
   * Returns an array of reconstructed TestCase-like objects plus metadata.
   */
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

    // Now parse the comment block into test cases
    // We look for the pattern: "Case: ..." which starts each case block
    const cases = [];
    let current = null;
    let section = null; // "input" | "expected" | "obtained" | null

    function pushCurrent() {
      if (current) {
        // Trim trailing blank lines
        if (current.input) current.input = current.input.replace(/\n+$/, "");
        if (current.expected) current.expected = current.expected.replace(/\n+$/, "");
        if (current.obtained) current.obtained = current.obtained.replace(/\n+$/, "");
        cases.push(current);
        current = null;
        section = null;
      }
    }

    for (const line of commentLines) {
      // New case marker - several formats used by different BIOTES versions
      const caseMatch =
        line.match(/^Case\s*:\s*(.*)$/i) ||
        line.match(/^-+\s*Case\s*:\s*(.*)$/i) ||
        line.match(/^Case\s+(\d+)/i);

      if (caseMatch) {
        pushCurrent();
        current = {
          description: caseMatch[1] ? caseMatch[1].trim() : "",
          input: "",
          expected: "",
          obtained: "",
          passed: false,
          source: "reconstructed",
        };
        section = null;
        continue;
      }

      if (!current) continue;

      // Section headers
      if (/^Input\s*:?\s*$/i.test(line)) { section = "input"; continue; }
      if (/^Expected\s+output\s*:?\s*$/i.test(line)) { section = "expected"; continue; }
      if (/^Obtained\s+output\s*:?\s*$/i.test(line)) { section = "obtained"; continue; }
      if (/^(Not\s+match|Match|OK|Fail)/i.test(line)) {
        current.passed = /^(Match|OK)/i.test(line);
        section = null;
        continue;
      }

      // Content lines
      if (section === "input") {
        current.input += (current.input ? "\n" : "") + line;
      } else if (section === "expected") {
        current.expected += (current.expected ? "\n" : "") + line;
      } else if (section === "obtained") {
        current.obtained += (current.obtained ? "\n" : "") + line;
      }
    }

    pushCurrent();

    return { cases, grade };
  }

  /**
   * Convert parsed evaluation cases into vpl_evaluate.cases text format.
   * Only includes cases where we have enough data (input + expected).
   */
  function toCasesFileText(evaluationResult) {
    const { cases } = evaluationResult;
    const parts = [];

    for (const c of cases) {
      if (!c.expected) continue; // can't reconstruct without expected output

      const lines = [];
      lines.push(`case = ${c.description || "Reconstructed case"}`);

      if (c.input !== undefined) {
        lines.push(`input = ${c.input}`);
      }

      lines.push(`output = ${c.expected}`);
      lines.push(""); // blank separator
      parts.push(lines.join("\n"));
    }

    return parts.join("\n");
  }

  /**
   * Try to extract cases from all captured WebSocket streams.
   * Returns { casesText, caseCount, grade, streamCount }.
   */
  function extractFromCapture() {
    const capture = window.__vplocalCapture;
    if (!capture) return null;

    const streams = capture.getStreams();
    const urls = Object.keys(streams);
    if (!urls.length) return null;

    let bestResult = null;
    let bestCount = 0;

    for (const url of urls) {
      const raw = joinFrames(streams[url]);
      if (!raw.includes("Comment:=>>") && !raw.includes("Grade:=>>")) continue;

      const result = parseEvaluationStream(raw);
      if (result.cases.length > bestCount) {
        bestCount = result.cases.length;
        bestResult = result;
      }
    }

    if (!bestResult || bestCount === 0) return null;

    return {
      casesText: toCasesFileText(bestResult),
      caseCount: bestResult.cases.length,
      grade: bestResult.grade,
      streamCount: urls.length,
    };
  }

  return { extractFromCapture, parseEvaluationStream, toCasesFileText };
})();
