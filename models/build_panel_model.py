#!/usr/bin/env python3
"""Rebuild models/manga109_panels_yolo26s_fp16.onnx from the published checkpoint.

    pip install ultralytics onnx onnxslim
    python3 models/build_panel_model.py best.pt models/manga109_panels_yolo26s_fp16.onnx

best.pt is ShadowB/Manga109-panel-balloon-text-yolov26-segmentation on Hugging Face (a pickle:
only load one you trust). Three steps:

1. ultralytics ONNX export with dynamic height/width (opset 17, onnxslim), so the browser can feed
   the rectangular letterbox js/yolo.js builds.
2. Keep only output0, the detection head. The mask prototypes (output1) are computed by a branch
   nothing else needs, so it goes too: about a quarter of the inference time.
3. Store every float weight as fp16 followed by a Cast to fp32. ONNX Runtime folds the casts when
   the session loads, so the file is half the size and inference is still fp32.
"""
import os
import shutil
import sys
import tempfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper, utils


def export(pt, workdir):
    from ultralytics import YOLO
    local = os.path.join(workdir, "model.pt")
    shutil.copy(pt, local)
    return YOLO(local).export(format="onnx", dynamic=True, simplify=True, opset=17)


def detection_head_only(model):
    head = model.graph.output[0].name
    sub = utils.Extractor(model).extract_model([i.name for i in model.graph.input], [head])
    sub.metadata_props.extend(model.metadata_props)
    del sub.opset_import[:]
    sub.opset_import.extend(model.opset_import)
    return sub


def fp16_weights(model):
    g = model.graph
    inits, casts = [], []
    for init in g.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype != np.float32 or arr.size < 16:
            inits.append(init)
            continue
        inits.append(numpy_helper.from_array(arr.astype(np.float16), init.name + "_f16"))
        casts.append(helper.make_node("Cast", [init.name + "_f16"], [init.name], to=TensorProto.FLOAT,
                                      name=init.name + "_cast"))
    del g.initializer[:]
    g.initializer.extend(inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    return model


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as tmp:
        onnx_path = src if src.endswith(".onnx") else export(src, tmp)
        model = fp16_weights(detection_head_only(onnx.load(onnx_path)))
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"{dst}: {os.path.getsize(dst) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
