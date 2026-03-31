"""
Tests for BIOTES-compatible comparators in run_tests.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../runner'))

from run_tests import compare_output, _numbers_match, _text_match, _exact_match, _regex_match


# ---------------------------------------------------------------------------
# Number comparator
# ---------------------------------------------------------------------------
class TestNumbersMatch:
    def test_integers_equal(self):
        assert _numbers_match("42", "42")

    def test_integers_different(self):
        assert not _numbers_match("42", "43")

    def test_floats_within_tolerance(self):
        assert _numbers_match("3.14159", "3.14160")

    def test_floats_outside_tolerance(self):
        assert not _numbers_match("3.14159", "3.15000")

    def test_float_zero_expected(self):
        assert _numbers_match("0", "0.0")
        assert _numbers_match("0.0", "0.000001")  # absolute tolerance
        assert not _numbers_match("0.0", "0.01")

    def test_multiple_numbers_on_line(self):
        assert _numbers_match("1 2 3", "1 2 3")
        assert not _numbers_match("1 2 3", "1 2 4")

    def test_numbers_with_surrounding_text(self):
        # Numbers comparator ignores non-numeric text
        assert _numbers_match("Result: 42", "The answer is 42")

    def test_count_mismatch(self):
        assert not _numbers_match("1 2 3", "1 2")

    def test_scientific_notation(self):
        assert _numbers_match("1e3", "1000")
        assert _numbers_match("2.5e-1", "0.25")

    def test_negative_numbers(self):
        assert _numbers_match("-5", "-5")
        assert not _numbers_match("-5", "5")


# ---------------------------------------------------------------------------
# Text comparator (case-insensitive, punctuation-insensitive)
# ---------------------------------------------------------------------------
class TestTextMatch:
    def test_same_text(self):
        assert _text_match("hello world", "hello world")

    def test_case_insensitive(self):
        assert _text_match("Hello World", "hello world")
        assert _text_match("HELLO", "hello")

    def test_ignores_punctuation(self):
        assert _text_match("hello, world!", "hello world")
        # "a.b.c" tokenizes to ["a","b","c"], "abc" tokenizes to ["abc"] — different tokens
        assert not _text_match("a.b.c", "abc")
        # but dots between identical word sequences are ignored
        assert _text_match("hello. world.", "hello world")

    def test_ignores_extra_whitespace(self):
        assert _text_match("hello   world", "hello world")
        assert _text_match("  hello  ", "hello")

    def test_different_text(self):
        assert not _text_match("hello", "world")

    def test_empty(self):
        assert _text_match("", "")
        assert not _text_match("hello", "")

    def test_alphanumeric_preserved(self):
        assert _text_match("test123", "test123")
        assert not _text_match("test123", "test124")


# ---------------------------------------------------------------------------
# Exact comparator
# ---------------------------------------------------------------------------
class TestExactMatch:
    def test_exact_quoted(self):
        assert _exact_match('"hello world"', "hello world")

    def test_case_sensitive(self):
        assert not _exact_match('"Hello"', "hello")

    def test_preserves_punctuation(self):
        assert _exact_match('"hello, world!"', "hello, world!")
        assert not _exact_match('"hello, world!"', "hello world")

    def test_trailing_newline_trimmed(self):
        assert _exact_match('"hello"', "hello\n")
        assert _exact_match('"hello"', "hello\n\n")

    def test_without_quotes(self):
        # Without quotes, strip and compare directly
        assert _exact_match("hello", "hello")

    def test_empty_string(self):
        assert _exact_match('""', "")
        assert _exact_match('""', "\n")


# ---------------------------------------------------------------------------
# Regex comparator
# ---------------------------------------------------------------------------
class TestRegexMatch:
    def test_simple_match(self):
        assert _regex_match("/hello/", "hello world")

    def test_no_match(self):
        assert not _regex_match("/xyz/", "hello world")

    def test_case_insensitive_flag(self):
        assert _regex_match("/HELLO/i", "hello world")

    def test_number_pattern(self):
        assert _regex_match(r"/\d+/", "the answer is 42")
        assert not _regex_match(r"/\d+/", "no numbers here")

    def test_anchored_pattern(self):
        assert _regex_match("/^hello/", "hello world")
        assert not _regex_match("/^world/", "hello world")

    def test_invalid_regex(self):
        # Should not raise, should return False
        assert not _regex_match("/[invalid/", "test")

    def test_multiline_flag(self):
        assert _regex_match("/^line2/m", "line1\nline2\nline3")


# ---------------------------------------------------------------------------
# Top-level compare_output (type detection)
# ---------------------------------------------------------------------------
class TestCompareOutput:
    def test_detects_exact(self):
        assert compare_output('"exact match"', "exact match")
        assert not compare_output('"exact match"', "EXACT MATCH")

    def test_detects_regex(self):
        assert compare_output("/hell.+/", "hello world")

    def test_detects_numbers(self):
        assert compare_output("42", "42")
        # 3.14 vs 3.14159: relative error ≈ 0.05% > 0.01% threshold → FAIL
        assert not compare_output("3.14", "3.14159")
        # 3.14159 vs 3.14160: relative error ≈ 0.0003% < 0.01% → PASS
        assert compare_output("3.14159", "3.14160")
        assert not compare_output("3.14", "3.15")

    def test_detects_text(self):
        assert compare_output("hello world", "HELLO, WORLD!")

    def test_number_line_detection(self):
        # "42 100" — all tokens are numbers → numbers mode
        assert compare_output("42 100", "42 100")
        assert not compare_output("42 100", "42 101")

    def test_mixed_line_is_text(self):
        # "Result: 42" — has non-numeric text → text mode
        assert compare_output("Result: 42", "result 42")
