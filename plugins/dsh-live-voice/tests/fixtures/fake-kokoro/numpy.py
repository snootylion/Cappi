"""Minimal NumPy stand-in for the isolated Kokoro sidecar fixture.

The fixture exercises command ordering, not numeric inference. Keeping this
under the test-only PYTHONPATH makes the macOS CI test independent of whatever
Python packages happen to be preinstalled on the hosted runner.
"""

float32 = object()


class _Array:
    def __init__(self, values):
        self._values = list(values)

    def reshape(self, *_shape):
        return self

    @property
    def size(self):
        return len(self._values)

    def tobytes(self):
        # The test asserts cancellation ordering only; valid opaque bytes are
        # sufficient for the sidecar's base64 protocol path.
        return b"\x00" * (len(self._values) * 4)


def array(values, dtype=None):
    del dtype
    return _Array(values)


def asarray(values, dtype=None):
    del dtype
    return values if isinstance(values, _Array) else _Array(values)
