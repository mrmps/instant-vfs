"""Export a Model2Vec static embedding model to gitvfs's compact int8 format.

    python bench/export-model.py minishlab/potion-code-16M-v2 potion-code-16M-v2.m2v
    wrangler r2 object put gitvfs-models/potion-code-16M-v2.m2v --file potion-code-16M-v2.m2v

Format (little-endian): b"M2V1" | u32 header_len | JSON header | float32 scale[V] | int8 weights[V*dim].
Header: {model, dim, vocab[], unk_id, median_token_length, max_length, max_input_chars_per_word, lowercase, prefix}.
Per-row int8 quantisation keeps cosine similarity to the fp16 original above 0.9999.
Requires `pip install model2vec numpy`.
"""
import json
import struct
import sys

import numpy as np
from model2vec import StaticModel


def main(name: str, out: str) -> None:
    m = StaticModel.from_pretrained(name)
    E = m.embedding.astype(np.float32)
    V, D = E.shape
    inv = [None] * V
    for tok, i in m.tokenizer.get_vocab().items():
        inv[i] = tok
    assert all(t is not None for t in inv), "vocab has holes"
    scale = np.abs(E).max(axis=1, keepdims=True) / 127.0
    scale[scale == 0] = 1
    Q = np.round(E / scale).astype(np.int8)
    header = {
        "model": name, "dim": int(D), "vocab": inv, "unk_id": m.unk_token_id,
        "median_token_length": int(m.median_token_length), "max_length": 512,
        "max_input_chars_per_word": 100, "lowercase": True, "prefix": "##",
    }
    hb = json.dumps(header, ensure_ascii=False).encode("utf-8")
    with open(out, "wb") as f:
        f.write(b"M2V1")
        f.write(struct.pack("<I", len(hb)))
        f.write(hb)
        f.write(scale.astype(np.float32).tobytes())
        f.write(Q.tobytes())
    # Sanity: quantisation loss on a few strings.
    def enc(M, s):
        ids = m.tokenize([s])[0]
        v = M[ids].mean(0)
        return v / (np.linalg.norm(v) + 1e-32)
    Er = Q.astype(np.float32) * scale
    for s in ["where is the request body size limit enforced", "def read_file(path):\n    return open(path).read()"]:
        print(f"cos(fp32, int8) = {float(enc(E, s) @ enc(Er, s)):.5f}  {s[:40]!r}")
    print(f"wrote {out}: {V} tokens x {D} dims")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
