# PDF Renamer

PySide6 で作ったデスクトップ GUI アプリです。PDF をドラッグ&ドロップし、OpenAI API で内容を解析して、安全な候補ファイル名を提案し、確認後にローカルファイルをリネームします。

## Setup

```bash
brew install python@3.12
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
.env に OPENAI_API_KEY を設定
.venv/bin/python main.py
```

`.env` の例:

```bash
OPENAI_API_KEY=sk-...
```

## Notes

- ログは `logs/app.log` に保存されます。
- 命名ルール設定は `config/settings.json` に保存されます。
- 使えるトークンは `{date}`, `{issuer_name}`, `{document_type}`, `{amount}`, `{title}` です。
- デフォルトの命名ルールは `{date}_{issuer_name}_{document_type}_{amount}` です。
- 現在の最小構成では `pypdf` でテキスト抽出してから OpenAI に送ります。
- 画像のみのスキャン PDF は OCR 未対応のため、そのままでは解析できません。
