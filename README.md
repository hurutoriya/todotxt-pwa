# Todo.txt PWA

🌐 公開URL: https://hurutoriya.github.io/todotxt-pwa/

todo.txt 規格準拠のローカルファーストなタスク管理PWAです。ホスティングは GitHub Pages を想定したビルド不要の静的構成です。

## 特徴

- **todo.txt 仕様準拠**: `x 完了日 作成日 (A) 本文 +Project @ctx key:value` をパース・保存（[仕様](https://github.com/todotxt/todo.txt)）
  - 優先度 `(A)`〜`(Z)`、作成日・完了日、`+プロジェクト`、`@コンテキスト`、`due:YYYY-MM-DD` 等の `key:value` に対応
  - 完了トグル時は完了日を自動付与、編集は raw 1行 + 構造化フォームの両対応
- **起動時にローカルファイルを選択**: 初回起動時にファイル選択画面を表示
  - Chrome / Edge: File System Access API で開いたファイルへ直接上書き保存（自動保存・外部変更検出・最近使ったファイル対応）
  - Firefox / Safari 等: `<input type=file>` + ダウンロード保存フォールバック
- **常時復元**: 一度開いた内容はブラウザ内（localStorage）に自動保存され、PWAを閉じても次回起動時に選択なしでそのまま開きます
  - 権限が残っている場合は元のファイルハンドルに静かに再接続し、直接保存を継続
  - 明示的に「✕ 閉じる」を押すと保存内容を破棄し、次回は選択画面に戻ります
  - データは外部送信されません（ローカルのみ）
- **PWA**: マニフェスト + Service Worker でオフライン動作・インストール対応
- **GitHub Pages 対応**: 相対パス (`./`) のみ使用のため `/<repo>/` サブパスでも動作

## 使い方

1. このリポジトリを GitHub に push し、Settings → Pages → Source を **GitHub Actions** にする
2. `https://<user>.github.io/<repo>/` を開く
3. 起動画面で「ファイルを選択…」→ ローカルの `todo.txt` を選択（新規作成・サンプル試用も可）
4. タスクの追加・検索・`+`/`@`/優先度フィルタ・並び替え・編集・完了整理（`done.txt` 出力）

## ローカル開発

ビルド不要です。ESモジュール利用のため `file://` 直開きではなくローカルサーバーで確認してください。

```sh
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

## 構成

```
index.html            起動時ファイル選択 + 一覧UI
styles.css
js/parser.js          todo.txt パーサ・シリアライザ
js/file-manager.js    File System Access + IndexedDB + fallback
js/app.js             UI・保存・PWA登録
manifest.webmanifest
sw.js                 cache-first Service Worker
icons/                PWAアイコン
sample-todo.txt       サンプル
.github/workflows/pages.yml  Pages デプロイ
```

## 注意

- ブラウザのセキュリティ上、リロード後に同じファイルへ書き戻すには起動画面の「最近使ったファイル」から再許可が必要です
- iOS Safari 等の未対応ブラウザでは編集後に「⬇ 保存」ボタンでダウンロード保存してください
