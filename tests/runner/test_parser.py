"""
Tests for the vpl_evaluate.cases parser in run_tests.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../runner'))

from run_tests import parse_cases


SIMPLE_CASES = """
case = Addition
input = 5 3
output = 8

case = Subtraction
input = 10 4
output = 6
"""

MULTILINE_CASES = """
case = Matrix Input
input = 3 3
1 2 3
4 5 6
7 8 9
output = 45

case = Empty Input
input =
output = 0
"""

FULL_OPTIONS_CASE = """
case = Full Options
input = hello
output = HELLO
grade reduction = 50%
fail message = Make sure to uppercase the input
expected exit code = 0
"""

MULTIPLE_OUTPUTS = """
case = Accept Multiple
input = 1 2
output = 3
output = "3"
output = /^3/
"""

EXACT_OUTPUT = """
case = Exact Test
input = test
output = "Hello, World!"
"""

REGEX_OUTPUT = """
case = Regex Test
input = abc
output = /^[a-z]+$/i
"""


class TestParser:
    def test_parses_simple_cases(self):
        cases = parse_cases(SIMPLE_CASES)
        assert len(cases) == 2
        assert cases[0].description == "Addition"
        assert cases[0].input == "5 3"
        assert cases[0].outputs == ["8"]
        assert cases[1].description == "Subtraction"
        assert cases[1].outputs == ["6"]

    def test_parses_multiline_input(self):
        cases = parse_cases(MULTILINE_CASES)
        assert len(cases) == 2
        assert "1 2 3" in cases[0].input
        assert "4 5 6" in cases[0].input
        assert cases[0].outputs == ["45"]

    def test_empty_input(self):
        cases = parse_cases(MULTILINE_CASES)
        assert cases[1].input == ""

    def test_grade_reduction_percent(self):
        cases = parse_cases(FULL_OPTIONS_CASE)
        assert len(cases) == 1
        assert cases[0].grade_reduction == ("percent", 50.0)

    def test_fail_message(self):
        cases = parse_cases(FULL_OPTIONS_CASE)
        assert "uppercase" in cases[0].fail_message

    def test_expected_exit_code(self):
        cases = parse_cases(FULL_OPTIONS_CASE)
        assert cases[0].expected_exit == 0

    def test_multiple_outputs(self):
        cases = parse_cases(MULTIPLE_OUTPUTS)
        assert len(cases) == 1
        assert len(cases[0].outputs) == 3
        assert "3" in cases[0].outputs
        assert '"3"' in cases[0].outputs

    def test_exact_output(self):
        cases = parse_cases(EXACT_OUTPUT)
        assert cases[0].outputs[0] == '"Hello, World!"'

    def test_regex_output(self):
        cases = parse_cases(REGEX_OUTPUT)
        assert cases[0].outputs[0] == "/^[a-z]+$/i"

    def test_empty_input_returns_empty_list(self):
        assert parse_cases("") == []
        assert parse_cases("# just a comment\n\n") == []

    def test_default_source_is_fetched(self):
        cases = parse_cases(SIMPLE_CASES)
        assert all(c.source == "fetched" for c in cases)

    def test_grade_reduction_absolute(self):
        text = "case = Test\ninput = 1\noutput = 1\ngrade reduction = 2.5\n"
        cases = parse_cases(text)
        assert cases[0].grade_reduction == ("absolute", 2.5)

    def test_no_trailing_newline_in_output(self):
        text = "case = Test\ninput = a\noutput = hello\n"
        cases = parse_cases(text)
        assert cases[0].outputs[0] == "hello"


class TestGradeComputation:
    """Test grade_range / n_cases default deduction logic."""

    def _make_results(self, passed_list):
        """passed_list: list of bool, returns results tuples"""
        return [(p, "", 0, False) for p in passed_list]

    def test_all_pass(self):
        from run_tests import parse_cases, compute_grade
        cases = parse_cases(SIMPLE_CASES)
        results = self._make_results([True, True])
        assert compute_grade(cases, results, 10.0) == 10.0

    def test_all_fail(self):
        from run_tests import parse_cases, compute_grade
        cases = parse_cases(SIMPLE_CASES)
        results = self._make_results([False, False])
        assert compute_grade(cases, results, 10.0) == 0.0

    def test_one_fail_of_two(self):
        from run_tests import parse_cases, compute_grade
        cases = parse_cases(SIMPLE_CASES)
        results = self._make_results([True, False])
        assert compute_grade(cases, results, 10.0) == 5.0

    def test_percent_reduction(self):
        from run_tests import compute_grade
        cases = parse_cases(FULL_OPTIONS_CASE)
        results = self._make_results([False])
        # 50% reduction on grade_range=10 → 5 deducted → grade=5
        grade = compute_grade(cases, results, 10.0)
        assert grade == 5.0

    def test_floor_at_zero(self):
        from run_tests import compute_grade
        text = "\n".join([
            f"case = Test {i}\ninput = {i}\noutput = {i}\ngrade reduction = 100%\n"
            for i in range(5)
        ])
        cases = parse_cases(text)
        results = self._make_results([False] * 5)
        assert compute_grade(cases, results, 10.0) == 0.0
