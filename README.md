# VPLocal

Test your VPL (Virtual Programming Lab) assignments locally before submitting to Moodle.

Stop clicking "Evaluate" 50 times while you develop. Run the exact same tests on your machine, submit once when you're done.

---

## The Problem

VPL is a Moodle plugin that auto-grades programming assignments. Students write code in a browser IDE and click **Evaluate** to run their code against test cases on a remote jail server. When dozens of students hit that server every few minutes while developing, it gets overloaded.

## The Solution

VPLocal intercepts the VPL workflow at the browser level:

1. You click **Evaluate** once in VPL — VPLocal silently captures the test case data from the evaluation output stream
2. You click **⬇ VPLocal** — a ZIP downloads with your source files, the captured test cases, and a local runner
3. You unzip and run `python3 run_tests.py` on your machine as many times as you want
4. You submit to VPL only once, when you're confident

No server required. No admin required. Works at any institution.

---

## Installation

### Prerequisites

- [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Firefox, Edge, Safari)
- Python 3.6+ (for the local runner)
- A C/C++ compiler: `gcc` or `g++`

### Install VPLocal

1. Make sure Tampermonkey is installed in your browser
2. Click this link: **[Install VPLocal](https://raw.githubusercontent.com/vazleo/vplocal/main/userscript/vplocal.user.js)**
3. Tampermonkey will detect the userscript and show an install prompt — click **Install**

That's it. VPLocal is now active on all VPL pages.

---

## Usage

### Step 1 — Capture test cases

Open a VPL assignment on Moodle. Write some code (even incomplete), then click **Evaluate** in the VPL IDE. This feeds the WebSocket interceptor — VPLocal silently captures the evaluation output stream in the background.

> **Why is this needed?** Professors typically hide the test case files. VPLocal reconstructs them from the evaluation feedback, which shows the input and expected output for every case you failed.

### Step 2 — Download the local test package

After the evaluation finishes, click the **⬇ VPLocal** button that appears in the IDE toolbar.

A ZIP file downloads: `vplocal_<assignment_name>.zip`

### Step 3 — Run locally

```bash
unzip vplocal_assignment_name.zip
cd vplocal_assignment_name
python3 run_tests.py
```

Example output:

```
  Detected: C++  (main.cpp)
  Compiled: OK
  Running 8 test case(s) (timeout: 10.0s each)...

  ============================================================
    VPLocal Test Results
  ============================================================
    Case  1: PASS  Sum two numbers
    Case  2: PASS  Sum negatives
    Case  3: FAIL  Large input
              expected: 1000000
                actual: 999999
    Case  4: PASS  Zero case
  ...
  ------------------------------------------------------------
    Result:  7/8 cases passed
    Grade:   8.8/10
  ============================================================
```

### Step 4 — Fix and repeat

Edit your source file, run `python3 run_tests.py` again. No internet required.

### Step 5 — Submit

When all cases pass locally, click **Evaluate** in VPL to get your official grade.

---

## Runner Options

```
python3 run_tests.py                     # run all cases
python3 run_tests.py --case 3            # run only case #3
python3 run_tests.py --no-color          # disable ANSI color
python3 run_tests.py --timeout 5         # per-case timeout in seconds (default: 10)
python3 run_tests.py --cases file.cases  # specify a different cases file
python3 run_tests.py --grade-range 10    # set maximum grade (default: 10)
```

---

## How It Works

### Test Case Capture Strategies

VPLocal tries four strategies in order, stopping at the first that works:

| Strategy | When it works | How |
|---|---|---|
| **A — Direct fetch** | Professor left cases readable | Fetches `vpl_evaluate.cases` via Moodle REST API |
| **B — WebSocket intercept** | After ≥1 evaluate run with VPLocal installed | Monkey-patches `WebSocket` at page load, captures evaluation stream, parses `Comment:=>>` blocks |
| **C — Saved result** | A previous evaluation result exists | Fetches last result via `mod_vpl_get_result`, parses feedback |
| **D — Manual paste** | Anything else | Dialog box where you paste the cases content manually |

Strategy B is the primary strategy. It works even when the professor hides the test cases because VPL's evaluation feedback already reveals the input and expected output for every failed case.

### Output Comparison (BIOTES-compatible)

The local runner replicates VPL's BIOTES grading logic:

| Type | How to recognize | Matching rule |
|---|---|---|
| **Numbers** | Output contains only numeric tokens | Extracts numbers, compares with 0.01% relative tolerance |
| **Text** | Default | Tokenizes alphanumeric words, compares case-insensitively |
| **Exact** | Expected wrapped in `"quotes"` | Character-by-character, case-sensitive |
| **Regex** | Expected wrapped in `/pattern/flags` | Python `re.search()` with flag mapping |

### Language Support

| Language | File extension | Compile command | Run command |
|---|---|---|---|
| C | `.c` | `gcc -o prog *.c -lm` | `./prog` |
| C++ | `.cpp` / `.cxx` | `g++ -o prog *.cpp` | `./prog` |
| Python | `.py` | — | `python3 main.py` |
| Java | `.java` | `javac *.java` | `java Main` |

The runner auto-detects your language from the file extensions in the current directory.

---

## Downloaded ZIP Contents

```
vplocal_<assignment>/
├── run_tests.py          # the local runner (self-contained, no pip needed)
├── vpl_evaluate.cases    # reconstructed or fetched test cases
├── README.md             # coverage note and quick start
└── main.c / main.cpp / … # your source file(s)
```

### Coverage Note

The `README.md` inside the ZIP tells you exactly where each test case came from:

- **Fetched from server** — complete and authoritative
- **Reconstructed from evaluation stream** — only cases you *failed* on the captured run are included; cases you passed are not available (your code already handles them)
- **Manually entered** — whatever you pasted

---

## Project Structure

```
vplocal/
├── userscript/
│   ├── vplocal.user.js          # distributable Tampermonkey script
│   └── src/
│       ├── interceptor.js       # WebSocket monkey-patch (Strategy B)
│       ├── extractor.js         # Comment:=>> parser → vpl_evaluate.cases
│       ├── api.js               # Moodle REST client (Strategies A + C)
│       ├── ui.js                # button injection + status panel
│       └── packager.js          # JSZip assembly + download trigger
├── runner/
│   └── run_tests.py             # BIOTES-compatible local test runner
└── tests/
    └── runner/
        ├── test_comparators.py  # unit tests for all 4 output comparators
        ├── test_parser.py       # unit tests for case file parser + grader
        └── fixtures/            # sample C / C++ / Python programs and cases
```

---

## Running the Tests

```bash
pip install pytest
python3 -m pytest tests/runner/ -v
```

---

## Security and Ethics

- VPLocal reads files using your own authenticated Moodle session — it has exactly the same access you have in your browser. It does not exploit any vulnerability.
- Test cases the professor chose to hide remain hidden. VPLocal only reconstructs cases from feedback that VPL already showed you.
- The goal is to reduce load on shared infrastructure, not to circumvent grading. You still submit through VPL.
- The `@connect *` in the userscript allows requests to any domain. You can tighten this to your institution's Moodle domain by editing the header.

---

## License

MIT
