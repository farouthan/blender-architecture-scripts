"""The committed cross-language fixtures must still match what Python computes.

If this fails, the solve maths changed: rerun ``python tests/generate_fixtures.py``
and check that ``npm test`` in the frontend still passes with the new numbers.
"""

import json
from pathlib import Path

import pytest

from generate_fixtures import CASES, build

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "test" / "fixtures.json"


def _round(obj, places=9):
    if isinstance(obj, float):
        return round(obj, places)
    if isinstance(obj, (list, tuple)):
        # JSON has no tuples, so normalise before comparing round-tripped data.
        return [_round(v, places) for v in obj]
    if isinstance(obj, dict):
        return {k: _round(v, places) for k, v in obj.items()}
    return obj


def test_fixture_file_matches_the_current_solve():
    assert FIXTURES.is_file(), "run tests/generate_fixtures.py"
    committed = json.loads(FIXTURES.read_text())["cases"]
    assert _round(committed) == _round(build()), (
        "the solve changed; regenerate frontend/test/fixtures.json and re-run npm test"
    )


@pytest.mark.parametrize("index", range(len(CASES)))
def test_every_fixture_is_a_usable_camera(index):
    case = build()[index]
    cam = case["expected"]["camera"]
    assert cam["focal_px"] > 0
    assert cam["position"][1] == pytest.approx(case["cameraHeight"])
    assert 5.0 < cam["vfovDeg"] < 150.0
    # The origin handle must project back onto itself.
    origin = case["controlPoints"]["origin"]
    projected = case["expected"]["projections"][0]
    assert projected["visible"]
    assert projected["uv"] == pytest.approx(origin, abs=1e-6)
