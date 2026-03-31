#!/usr/bin/env python3
"""
VPLocal - run_tests.py
Local BIOTES-compatible test runner for VPL (Virtual Programming Lab) assignments.

Usage:
    python3 run_tests.py                  # run all cases
    python3 run_tests.py --case 3         # run only case #3
    python3 run_tests.py --no-color       # disable ANSI color
    python3 run_tests.py --timeout 5      # per-case timeout in seconds (default: 10)
    python3 run_tests.py --cases file.cases  # specify cases file path
"""

import argparse
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------
RESET  = "\033[0m"
GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
DIM    = "\033[2m"

USE_COLOR = True

def green(s):  return f"{GREEN}{s}{RESET}" if USE_COLOR else s
def red(s):    return f"{RED}{s}{RESET}" if USE_COLOR else s
def yellow(s): return f"{YELLOW}{s}{RESET}" if USE_COLOR else s
def bold(s):   return f"{BOLD}{s}{RESET}" if USE_COLOR else s
def dim(s):    return f"{DIM}{s}{RESET}" if USE_COLOR else s


# ---------------------------------------------------------------------------
# Test case data structure
# ---------------------------------------------------------------------------
class TestCase:
    def __init__(self):
        self.description = ""
        self.input = ""
        self.outputs = []          # list of expected output strings (any match = pass)
        self.grade_reduction = None  # float or None (uses default)
        self.fail_message = ""
        self.program = None        # override binary to run
        self.arguments = ""        # extra CLI args
        self.expected_exit = None  # int or None
        self.source = "fetched"    # "fetched" | "reconstructed" | "manual"


# ---------------------------------------------------------------------------
# vpl_evaluate.cases parser
# ---------------------------------------------------------------------------
def parse_cases(text):
    """Parse vpl_evaluate.cases text into a list of TestCase objects."""
    cases = []
    current = None
    current_key = None
    current_val_lines = []

    def flush_value():
        nonlocal current, current_key, current_val_lines
        if current is None or current_key is None:
            return
        value = "\n".join(current_val_lines).rstrip("\n")
        if current_key == "case":
            current.description = value
        elif current_key == "input":
            current.input = value
        elif current_key == "output":
            current.outputs.append(value)
        elif current_key == "grade reduction":
            try:
                s = value.strip()
                if s.endswith("%"):
                    current.grade_reduction = ("percent", float(s[:-1]))
                else:
                    current.grade_reduction = ("absolute", float(s))
            except ValueError:
                pass
        elif current_key == "fail message":
            current.fail_message = value
        elif current_key == "program to run":
            current.program = value.strip()
        elif current_key == "program arguments":
            current.arguments = value.strip()
        elif current_key == "expected exit code":
            try:
                current.expected_exit = int(value.strip())
            except ValueError:
                pass
        current_key = None
        current_val_lines = []

    # Known statement keywords (lowercase)
    KEYS = {
        "case", "input", "output", "grade reduction", "fail message",
        "program to run", "program arguments", "expected exit code",
    }

    for line in text.splitlines():
        # Try to match a "key = value" statement
        m = re.match(r'^([a-zA-Z ]+?)\s*=\s*(.*)', line)
        if m:
            key_candidate = m.group(1).strip().lower()
            if key_candidate in KEYS:
                flush_value()
                if key_candidate == "case":
                    if current is not None:
                        cases.append(current)
                    current = TestCase()
                current_key = key_candidate
                rest = m.group(2)
                current_val_lines = [rest] if rest else []
                continue

        # Continuation line
        if current_key is not None:
            current_val_lines.append(line)

    flush_value()
    if current is not None:
        cases.append(current)

    return cases


# ---------------------------------------------------------------------------
# BIOTES comparators
# ---------------------------------------------------------------------------
_NUMBER_RE = re.compile(r'-?\d+\.?\d*(?:[eE][+-]?\d+)?')

def _extract_numbers(s):
    return [float(x) for x in _NUMBER_RE.findall(s)]

def _numbers_match(expected, actual):
    """Compare by extracting numeric tokens; floating-point tolerance 0.01%."""
    exp_nums = _extract_numbers(expected)
    act_nums = _extract_numbers(actual)
    if len(exp_nums) != len(act_nums):
        return False
    for e, a in zip(exp_nums, act_nums):
        if e == a:
            continue
        if e == 0:
            if abs(a) > 1e-6:
                return False
        elif abs((e - a) / e) > 0.0001:
            return False
    return True

def _tokenize(s):
    """Extract alphanumeric tokens, lowercased."""
    return re.findall(r'[a-zA-Z0-9]+', s.lower())

def _text_match(expected, actual):
    """Case-insensitive, punctuation/whitespace-insensitive token comparison."""
    return _tokenize(expected) == _tokenize(actual)

def _exact_match(expected, actual):
    """Strip enclosing quotes, trim trailing newlines, exact match."""
    e = expected.strip()
    if e.startswith('"') and e.endswith('"'):
        e = e[1:-1]
    return e.rstrip("\n") == actual.rstrip("\n")

def _regex_match(expected, actual):
    """Match /pattern/flags style expected against actual output."""
    m = re.match(r'^/(.*)/([imsa]*)$', expected.strip(), re.DOTALL)
    if not m:
        return False
    pattern, flags_str = m.group(1), m.group(2)
    flag_map = {'i': re.IGNORECASE, 'm': re.MULTILINE, 's': re.DOTALL, 'a': re.ASCII}
    flags = 0
    for ch in flags_str:
        flags |= flag_map.get(ch, 0)
    try:
        return bool(re.search(pattern, actual, flags))
    except re.error:
        return False

def _detect_output_type(expected):
    e = expected.strip()
    if e.startswith('"'):
        return "exact"
    if e.startswith('/') and re.match(r'^/.*/$', e) or re.match(r'^/.*/[imsa]*$', e):
        return "regex"
    # If every non-whitespace token looks like a number, use numbers mode
    tokens = e.split()
    if tokens and all(_NUMBER_RE.fullmatch(t) for t in tokens):
        return "numbers"
    return "text"

def compare_output(expected, actual):
    """Return True if actual matches expected using appropriate BIOTES comparator."""
    otype = _detect_output_type(expected)
    if otype == "exact":
        return _exact_match(expected, actual)
    elif otype == "regex":
        return _regex_match(expected, actual)
    elif otype == "numbers":
        return _numbers_match(expected, actual)
    else:
        return _text_match(expected, actual)


# ---------------------------------------------------------------------------
# Language detection and compilation
# ---------------------------------------------------------------------------
LANGUAGE_DISPATCH = {
    "c":      {"exts": [".c"],    "compile": ["gcc", "-o", "{out}", "{src}", "-lm"], "run": ["./{out}"]},
    "cpp":    {"exts": [".cpp", ".cxx", ".cc"], "compile": ["g++", "-o", "{out}", "{src}"], "run": ["./{out}"]},
    "python": {"exts": [".py"],   "compile": None, "run": ["python3", "{src}"]},
    "java":   {"exts": [".java"], "compile": ["javac", "{src}"], "run": ["java", "{classname}"]},
}

def _probe(names):
    for n in names:
        if shutil.which(n):
            return n
    return None

def detect_language(directory):
    """Return (language_key, source_file) for the primary source file found."""
    files = os.listdir(directory)
    for lang, info in LANGUAGE_DISPATCH.items():
        for f in files:
            if any(f.endswith(ext) for ext in info["exts"]):
                return lang, f
    return None, None

def compile_source(lang, src_file, workdir):
    """Compile source file; returns (success, error_message, binary_path)."""
    info = LANGUAGE_DISPATCH[lang]
    if info["compile"] is None:
        return True, "", src_file  # interpreted, no compilation

    binary = "vplocal_prog"
    classname = os.path.splitext(src_file)[0]

    cmd = []
    for part in info["compile"]:
        part = part.replace("{out}", binary)
        part = part.replace("{src}", src_file)
        part = part.replace("{classname}", classname)
        cmd.append(part)

    # Check compiler availability
    compiler = cmd[0]
    if not shutil.which(compiler):
        # Try fallbacks
        fallbacks = {"gcc": ["cc"], "g++": ["c++"], "python3": ["python"], "javac": []}
        for alt in fallbacks.get(compiler, []):
            if shutil.which(alt):
                cmd[0] = alt
                break
        else:
            return False, f"Compiler '{compiler}' not found. Please install it.", None

    result = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True)
    if result.returncode != 0:
        return False, result.stderr, None

    return True, "", os.path.join(workdir, binary)


def build_run_cmd(lang, src_file, binary_path, case, workdir):
    """Build the subprocess command list for running one test case."""
    info = LANGUAGE_DISPATCH[lang]
    classname = os.path.splitext(src_file)[0]

    # Override program if case specifies one
    if case.program:
        cmd = [os.path.join(workdir, case.program)]
    else:
        cmd = []
        for part in info["run"]:
            part = part.replace("{out}", os.path.basename(binary_path or "prog"))
            part = part.replace("{src}", src_file)
            part = part.replace("{classname}", classname)
            cmd.append(part)
        if lang in ("c", "cpp") and binary_path:
            cmd = [binary_path]

    if case.arguments:
        cmd += case.arguments.split()

    return cmd


# ---------------------------------------------------------------------------
# Test executor
# ---------------------------------------------------------------------------
def run_case(cmd, case, workdir, timeout):
    """
    Execute one test case.
    Returns (passed, actual_output, exit_code, timed_out).
    """
    try:
        result = subprocess.run(
            cmd,
            input=case.input,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=workdir,
        )
        actual = result.stdout
        exit_code = result.returncode
        timed_out = False
    except subprocess.TimeoutExpired:
        return False, "", None, True
    except FileNotFoundError as e:
        return False, str(e), None, False

    # Check exit code if required
    if case.expected_exit is not None and exit_code != case.expected_exit:
        return False, actual, exit_code, False

    # If no expected outputs defined, just check exit code (or pass trivially)
    if not case.outputs:
        return True, actual, exit_code, False

    # Any matching output = pass
    for expected in case.outputs:
        if compare_output(expected, actual):
            return True, actual, exit_code, False

    return False, actual, exit_code, False


# ---------------------------------------------------------------------------
# Grader
# ---------------------------------------------------------------------------
def compute_grade(cases, results, grade_range=10.0):
    """
    Compute grade using BIOTES default logic:
    default reduction per case = grade_range / n_cases
    """
    n = len(cases)
    if n == 0:
        return grade_range

    default_reduction = grade_range / n
    total_reduction = 0.0

    for case, (passed, *_) in zip(cases, results):
        if passed:
            continue
        if case.grade_reduction is None:
            total_reduction += default_reduction
        elif case.grade_reduction[0] == "percent":
            total_reduction += grade_range * case.grade_reduction[1] / 100.0
        else:
            total_reduction += case.grade_reduction[1]

    return max(0.0, grade_range - total_reduction)


# ---------------------------------------------------------------------------
# Reporter
# ---------------------------------------------------------------------------
def report(cases, results, grade, grade_range, source_counts):
    n = len(cases)
    passed = sum(1 for (ok, *_) in results if ok)

    print()
    print(bold("=" * 60))
    print(bold("  VPLocal Test Results"))
    print(bold("=" * 60))

    for i, (case, result) in enumerate(zip(cases, results), 1):
        ok, actual, exit_code, timed_out = result
        desc = case.description or f"Case {i}"
        src_tag = dim(f"[{case.source}]") if case.source != "fetched" else ""

        if timed_out:
            status = yellow("TIMEOUT")
        elif ok:
            status = green("PASS")
        else:
            status = red("FAIL")

        print(f"  {bold(f'Case {i:>2}:')} {status}  {desc} {src_tag}")

        if not ok and not timed_out:
            if case.fail_message:
                print(f"          {dim(case.fail_message)}")
            else:
                # Show first divergence
                exp = case.outputs[0] if case.outputs else "(no expected output)"
                act = actual if actual else "(no output)"
                exp_preview = exp.split('\n')[0][:60]
                act_preview = act.split('\n')[0][:60]
                print(f"          {dim('expected:')} {exp_preview}")
                print(f"          {dim('  actual:')} {act_preview}")

    print(bold("-" * 60))
    print(f"  {bold('Result:')}  {passed}/{n} cases passed")

    grade_str = f"{grade:.1f}/{grade_range:.0f}"
    if grade == grade_range:
        print(f"  {bold('Grade:')}   {green(grade_str)}")
    elif grade == 0:
        print(f"  {bold('Grade:')}   {red(grade_str)}")
    else:
        print(f"  {bold('Grade:')}   {yellow(grade_str)}")

    # Coverage note
    reconstructed = source_counts.get("reconstructed", 0)
    manual = source_counts.get("manual", 0)
    if reconstructed or manual:
        print()
        print(dim("  Coverage note:"))
        fetched = source_counts.get("fetched", 0)
        if fetched:
            print(dim(f"    {fetched} case(s) fetched from server"))
        if reconstructed:
            print(dim(f"    {reconstructed} case(s) reconstructed from evaluation feedback"))
            print(dim("    (only failed cases from the captured run — passed cases may differ)"))
        if manual:
            print(dim(f"    {manual} case(s) entered manually"))

    print(bold("=" * 60))
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global USE_COLOR

    parser = argparse.ArgumentParser(
        description="VPLocal — run VPL test cases locally"
    )
    parser.add_argument("--case", type=int, default=None,
                        help="Run only this case number (1-indexed)")
    parser.add_argument("--no-color", action="store_true",
                        help="Disable ANSI color output")
    parser.add_argument("--timeout", type=float, default=10.0,
                        help="Per-case timeout in seconds (default: 10)")
    parser.add_argument("--cases", default=None,
                        help="Path to vpl_evaluate.cases (default: auto-detect)")
    parser.add_argument("--grade-range", type=float, default=10.0,
                        help="Maximum grade value (default: 10)")
    args = parser.parse_args()

    if args.no_color:
        USE_COLOR = False

    # Working directory is always where the student runs the command from (cwd).
    # The script may live inside the same directory (bundled in zip) or elsewhere.
    workdir = os.getcwd()

    # Find cases file
    cases_path = args.cases
    if cases_path is None:
        candidates = [
            os.path.join(workdir, "vpl_evaluate.cases"),
            os.path.join(workdir, "evaluate.cases"),
        ]
        for c in candidates:
            if os.path.exists(c):
                cases_path = c
                break

    if not cases_path or not os.path.exists(cases_path):
        print(red("Error: could not find vpl_evaluate.cases in current directory."))
        print("Use --cases <path> to specify its location.")
        sys.exit(1)

    with open(cases_path, encoding="utf-8") as f:
        cases_text = f.read()

    cases = parse_cases(cases_text)
    if not cases:
        print(yellow("Warning: no test cases found in the cases file."))
        sys.exit(0)

    # Filter to single case if requested
    if args.case is not None:
        idx = args.case - 1
        if idx < 0 or idx >= len(cases):
            print(red(f"Error: case {args.case} does not exist (total: {len(cases)})"))
            sys.exit(1)
        cases = [cases[idx]]

    # Detect language
    lang, src_file = detect_language(workdir)
    if lang is None:
        print(red("Error: no recognized source file found."))
        print("Supported: .c  .cpp  .py  .java")
        sys.exit(1)

    print(f"  Detected: {bold(lang.upper())}  ({src_file})")

    # Compile
    ok, err, binary = compile_source(lang, src_file, workdir)
    if not ok:
        print(red("Compilation failed:"))
        print(err)
        sys.exit(1)
    if lang not in ("python",):
        print(f"  Compiled: {green('OK')}")

    # Run all cases
    results = []
    print(f"  Running {len(cases)} test case(s) (timeout: {args.timeout}s each)...")
    print()

    for case in cases:
        cmd = build_run_cmd(lang, src_file, binary, case, workdir)
        result = run_case(cmd, case, workdir, args.timeout)
        results.append(result)

    # Grade
    grade = compute_grade(cases, results, args.grade_range)

    # Source coverage counts
    source_counts = {}
    for case in cases:
        source_counts[case.source] = source_counts.get(case.source, 0) + 1

    # Report
    report(cases, results, grade, args.grade_range, source_counts)

    # Exit code: 0 if all passed, 1 otherwise
    all_passed = all(r[0] for r in results)
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
