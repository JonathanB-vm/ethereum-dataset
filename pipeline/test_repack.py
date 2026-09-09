"""Tests for the repack step's value parsing.

These cover the conversions where getting it wrong is *silent*: a bad cast in DuckDB
yields NULL rather than an error, so a whole column can quietly empty out without any
step of the pipeline failing.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import duckdb
import pytest

spec = importlib.util.spec_from_file_location("repack", Path(__file__).with_name("repack.py"))
assert spec and spec.loader
repack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repack)


@pytest.fixture
def con():
    c = duckdb.connect()
    c.execute("CREATE TABLE t(val VARCHAR)")
    return c


def parse_int(con, value, typ="UBIGINT"):
    con.execute("DELETE FROM t")
    con.execute("INSERT INTO t VALUES (?)", [value])
    return con.execute(f"SELECT {repack.small_int('val', typ)} FROM t").fetchone()[0]


def parse_str(con, value):
    con.execute("DELETE FROM t")
    con.execute("INSERT INTO t VALUES (?)", [value])
    return con.execute(f"SELECT {repack.int_str('val')} FROM t").fetchone()[0]


class TestSmallInt:
    """`v` and `y_parity` are STRING in BigQuery; the format was not documented."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("27", 27),
            ("28", 28),
            ("1", 1),
            ("0", 0),
        ],
    )
    def test_parses_decimal_strings(self, con, raw, expected):
        assert parse_int(con, raw) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("0x1b", 27),
            ("0x1c", 28),
            ("0x0", 0),
            ("0x1", 1),
            ("0x25", 37),
        ],
    )
    def test_parses_hex_strings(self, con, raw, expected):
        # DuckDB's cast understands the 0x prefix natively. Verified rather than assumed:
        # if it did not, try_cast would return NULL and every `v` would silently vanish.
        assert parse_int(con, raw) == expected

    def test_parses_uppercase_hex(self, con):
        assert parse_int(con, "0X1C") == 28

    def test_strips_the_pandas_float_suffix(self, con):
        # The CSV export writes some integers as "37.0".
        assert parse_int(con, "37.0") == 37

    @pytest.mark.parametrize("raw", ["", None])
    def test_empty_and_null_become_null(self, con, raw):
        assert parse_int(con, raw) is None

    def test_narrow_types_still_parse(self, con):
        assert parse_int(con, "0x1", "UTINYINT") == 1

    def test_garbage_becomes_null_rather_than_raising(self, con):
        # Documented behaviour, not desired behaviour: a malformed value is dropped
        # silently, which is why the verification step compares row counts and why these
        # tests exist at all.
        assert parse_int(con, "not-a-number") is None


class TestIntStr:
    """256-bit values travel as decimal strings; no fixed-width type holds 78 digits."""

    def test_preserves_a_full_256_bit_value(self, con):
        biggest = str(2**256 - 1)
        assert len(biggest) == 78
        assert parse_str(con, biggest) == biggest

    def test_preserves_a_37_digit_quantity(self, con):
        # A real value from the sample; a DOUBLE would have rounded it away.
        v = "4461668424664140127867736845293397079"
        assert parse_str(con, v) == v

    def test_strips_the_float_suffix(self, con):
        assert parse_str(con, "1794013457006467492343.0") == "1794013457006467492343"

    def test_does_not_strip_a_meaningful_trailing_zero(self, con):
        # "100" must stay "100" -- the suffix rule is anchored to a decimal point.
        assert parse_str(con, "100") == "100"

    @pytest.mark.parametrize("raw", ["", None])
    def test_empty_and_null_become_null(self, con, raw):
        assert parse_str(con, raw) is None


class TestConfiguration:
    def test_sort_keys_match_the_data_model(self):
        assert repack.SORT_KEY["token_transfers"] == (
            "block_number, transaction_index, event_index, batch_index"
        )
        assert repack.SORT_KEY["transactions"] == "block_number, transaction_index"

    def test_row_groups_sit_in_duckdb_guidance(self):
        # DuckDB guidance is 250k-500k rows per row group for analytics tables.
        assert 250_000 <= repack.ROW_GROUP["transactions"] <= 500_000
        assert 250_000 <= repack.ROW_GROUP["token_transfers"] <= 500_000

    def test_every_table_has_a_sort_key_and_row_group(self):
        for table in repack.TABLES:
            assert table in repack.SORT_KEY
            assert table in repack.ROW_GROUP
