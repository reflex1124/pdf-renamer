# PDF Renamer

PySide6 で作ったデスクトップ GUI アプリです。PDF や画像をドラッグ&ドロップし、OpenAI API で内容を解析して、安全な候補ファイル名を提案し、確認後にローカルファイルをリネームします。

## Setup

**macOS:**
```bash
brew install python@3.12
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Windows:**
```bash
py -3 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run

`.env` に `OPENAI_API_KEY` を設定してから:

**macOS:**
```bash
.venv/bin/python main.py
```

**Windows:**
```bash
.venv\Scripts\python main.py
```

`.env` の例:

```bash
OPENAI_API_KEY=sk-...
```

## Notes

- ログは `logs/app.log` に保存されます。
- 命名ルール設定は `config/settings.json` に保存されます。
- 使用する OpenAI モデル名も `config/settings.json` に保存されます。
- 使えるトークンは `{date}`, `{issuer_name}`, `{document_type}`, `{amount}`, `{title}` です。
- デフォルトの命名ルールは `{date}_{issuer_name}_{document_type}_{amount}` です。
- テキスト抽出できる PDF は `pypdf` で読み取ってから OpenAI に送ります。
- テキストのないスキャン PDF は OpenAI の PDF 入力を使った OCR fallback で解析します。
- `png`, `jpg`, `jpeg`, `webp`, `gif` の画像ファイルも解析できます。
