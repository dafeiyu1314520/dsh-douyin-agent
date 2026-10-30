"""本机 SenseVoice 转写入口，契约与插件原来的 local_whisper.py 相同：
stdin 读 {path, language, model, modelsDir}，stdout 吐 {text, language, segments}；
--probe 时只报依赖与模型是否就绪。不读服务凭据、不写其他文件。

实现换成 funasr + SenseVoiceSmall（中文比 whisper 准），模型路径见 SV_MODEL_DIR。
运行时用 tools\\sensevoice\\.venv 里的 python（DOUYIN_MEDIA_PYTHON 指定）。
"""
import contextlib
import json
import os
import re
import sys

DEFAULT_MODEL_DIR = r"D:\Deep\tools\sensevoice\models\models\iic--SenseVoiceSmall\snapshots\master"
MODEL_DIR = os.environ.get("SV_MODEL_DIR") or DEFAULT_MODEL_DIR
SUPPORTED = ("zh", "en", "ja", "ko", "yue")


def model_cached() -> bool:
    try:
        return any(name.endswith(".pt") for name in os.listdir(MODEL_DIR))
    except OSError:
        return False


def probe() -> int:
    try:
        import importlib.util

        dependency = importlib.util.find_spec("funasr") is not None
    except Exception:
        dependency = False
    cached = model_cached()
    print(json.dumps({"available": dependency and cached, "dependencyAvailable": dependency, "modelCached": cached}))
    return 0


def pick_language(value) -> str:
    text = (value or "auto").strip().lower()
    if text in SUPPORTED or text == "auto":
        return text
    return "auto"


EVENT_TAGS = {
    "bgm": "[背景音乐]", "applause": "[掌声]", "laughter": "[笑声]", "laugh": "[笑声]",
    "cry": "[哭声]", "sneeze": "[喷嚏]", "cough": "[咳嗽]", "breath": "[呼吸声]",
    "speech": "", "zh": "", "en": "", "yue": "", "ja": "", "ko": "", "nospeech": "",
    "happy": "", "sad": "", "angry": "", "neutral": "", "fearful": "", "disgusted": "",
    "surprised": "", "emo": "",
}


def clean(raw: str) -> str:
    # SenseVoice 给的是带事件标签的原文（<|ja|><|Speech|>…），不是人读的句子。
    # 2026-10-25：事件标签（BGM/笑声/掌声）保留成中文方括号，语言和情绪标签删掉。
    text = re.sub(r"<\|([^|]*)\|>", lambda m: EVENT_TAGS.get(m.group(1).strip().lower(), ""), raw or "")
    # 逐词空格在中文/日文里是噪音，去掉汉字与假名之间的空格
    text = re.sub(r"(?<=[\u4e00-\u9fff\u3040-\u30ff])\s+(?=[\u4e00-\u9fff\u3040-\u30ff])", "", text)
    return text.strip()


def main() -> int:
    if "--probe" in sys.argv:
        return probe()

    request = json.load(sys.stdin)
    source = request["path"]
    language = pick_language(request.get("language"))

    real_stdout = sys.stdout
    # funasr 会往 stdout 打日志和进度条，全部改道 stderr，别污染 JSON
    with contextlib.redirect_stdout(sys.stderr):
        from funasr import AutoModel

        model = AutoModel(model=MODEL_DIR, trust_remote_code=True, device="cpu", disable_update=True)
        result = model.generate(
            input=source,
            cache={},
            language=language,
            use_itn=True,
            batch_size_s=60,
            disable_pbar=True,
        )
        text = clean(result[0]["text"]) if result else ""

    json.dump({"text": text, "language": language, "segments": []}, real_stdout, ensure_ascii=False)
    real_stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
