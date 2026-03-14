# PDF Renamer

Electron + Astro で作ったデスクトップ GUI アプリです。PDF や画像をドラッグ&ドロップし、OpenAI API で内容を解析して、安全な候補ファイル名を提案し、確認後にローカルファイルをリネームします。

## Setup

Node.js 22 以上を使います。

```bash
npm install
```

開発時はリポジトリ直下に `.env` を置いて `OPENAI_API_KEY` を設定してください。

```bash
OPENAI_API_KEY=sk-...
```

配布ビルドでは、実行ファイルと同じディレクトリに置いた `.env` を優先して読み込みます。

## Run

開発起動:

```bash
npm run dev
```

型検査:

```bash
npm run typecheck
```

テスト:

```bash
npm test
```

ビルド:

```bash
npm run build
```

配布ビルド:

```bash
npm run dist
```

## Notes

- ログは Electron の `userData/logs/app.log` に保存されます。
- 命名ルール設定と使用モデルは Electron の `userData/settings.json` に保存されます。
- 使えるトークンは `{date}`, `{issuer_name}`, `{document_type}`, `{amount}`, `{title}`, `{description}` です。
- デフォルトの命名ルールは `{date}_{issuer_name}_{document_type}_{amount}` です。
- テキスト抽出できる PDF は Node 側でテキスト抽出してから OpenAI に送ります。
- テキストのないスキャン PDF は OpenAI の PDF 入力を使った OCR fallback で解析します。
- `png`, `jpg`, `jpeg`, `webp`, `gif` の画像ファイルも解析できます。
- 配布は `electron-builder` を使い、macOS は DMG、Windows は NSIS を生成します。
