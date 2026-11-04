# Panel detection model

`manga109_panels_yolo26s_fp16.onnx` (19.8 MB) is the detection head of
[ShadowB/Manga109-panel-balloon-text-yolov26-segmentation](https://huggingface.co/ShadowB/Manga109-panel-balloon-text-yolov26-segmentation),
a YOLO26s model trained on Manga109 to find panels (`frame`), text and speech balloons. It is
lazy-loaded by `js/manga-ui.js` only when AI panel detection is on, and decoded by `js/yolo.js`.

**Licence.** The model card says MIT. The weights are a fine-tune of Ultralytics' YOLO26s, and
Ultralytics' position is that such weights are AGPL-3.0, which the export's own metadata also
states. The model this one replaces (leoxs22/manga-panel-detector-yolo26n) is AGPL-3.0 for the
same reason, so shipping it changes nothing about the licence position. The training data is
Manga109; its terms ask that its use be acknowledged wherever models trained on it are published:
Aizawa et al., "Building a Manga Dataset 'Manga109' with Annotations for Multimedia
Applications", IEEE MultiMedia 27(2), 2020.

**Rebuilding.** `build_panel_model.py` turns the published `best.pt` into this file: ultralytics
ONNX export with dynamic input size, the mask branch cut off, weights stored as fp16. See its
docstring. The benchmark that chose this model, and the alternatives it beat, is described in
`test/README.md` under *Panel-detection benchmark*.
