import time

import numpy as np


class KokoroTTS:
    @classmethod
    def from_pretrained(cls, _source):
        return cls()

    def generate_stream(self, *, text, **_options):
        if text == "cancel before inference":
            raise RuntimeError("cancelled queued text reached model inference")
        time.sleep(0.05)
        yield np.array([0.1, -0.1], dtype=np.float32)

    def close(self):
        pass
