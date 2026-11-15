# API仕様確認記録

確認日：2026-11-01。公式資料の確認であり、実接続による確認ではありません。

## Claude API

| 項目 | 確認内容 | 出典 |
|---|---|---|
| モデルID | `claude-opus-5-5`。最初の選択肢として推奨。料金は入力$4、出力$20（100万トークンあたり）。退役は2027-09-22以降 | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) |
| APIバージョン | `anthropic-version: 2026-10-21` が最新 | [Versions](https://platform.claude.com/docs/en/api/versioning) |
| 削除されたパラメータ | `temperature` / `top_p` / `top_k` は400エラー。コードでは送らない | 同上 |
| 構造化出力 | `output_config.format`（`type: json_schema`）。`minLength` / `maxLength` などは非対応で400エラーのため、文字数はコード側で検証 | [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) |
| 配列の制約 | `minItems` は0か1のみ。見出し3個は `section_1`〜`3` の別項目で表現 | 同上 |
| 途中終了・拒否 | `stop_reason` が `max_tokens` や `refusal` のとき、出力はスキーマに合わない場合がある | 同上 |
| 思考 | Opus 5.5は常に有効で、無効化は400エラー。`thinking` は送らず `output_config.effort` で調整。既定は `medium` | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)、[Errors](https://platform.claude.com/docs/en/api/errors) |
| フォールバック | `fallbacks: "default"` と `anthropic-beta: server-side-fallback-2026-07-01`。ベータ機能。非ストリーミングでは拒否されたモデルの途中出力を含まない | [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback) |
| エラー | 400 / 401 / 402 / 403 / 404 / 409 / 413 / 429 / 500 / 504 / 529。`request_id` は本文に含まれる | [Errors](https://platform.claude.com/docs/en/api/errors) |
| ワークスペース | ワークスペースに紐づかないキーは、全リクエストに `anthropic-workspace-id: wrkspc_…` が必要（ないと400）。IDはConsoleのWorkspacesページのID列。2026-11-06、実接続の400エラーで判明 | [Authentication](https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace) |
| 接続確認 | `GET /v1/models/{id}` でモデル情報を取得できる | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) |

GASに公式SDKはないため、`UrlFetchApp` でHTTPを直接呼び出します。

## Google Apps Script

| 項目 | 確認内容 | 出典 |
|---|---|---|
| 実行時間 | 1実行6分 | [Quotas](https://developers.google.com/apps-script/guides/services/quotas) |
| プロパティ | 1値あたり9KB。サンプルをプロパティではなくシートに置く理由 | 同上 |
| URL Fetch | 1日20,000回（消費者アカウント） | 同上 |
| タイムアウト | `timeoutSeconds`。既定360秒 | [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app) |
| ロック | `getDocumentLock` はコンテナバインドのスクリプトで使用可能 | [LockService](https://developers.google.com/apps-script/reference/lock/lock-service) |

## WordPress REST API

| 項目 | 確認内容 | 出典 |
|---|---|---|
| 投稿作成 | `POST /wp/v2/posts`。`title` / `content` / `status` / `excerpt` | [Posts](https://developer.wordpress.org/rest-api/reference/posts/) |
| 下書き | `status` に `draft` を指定できる。`id` と `link` は読み取り専用で応答に含まれる | 同上 |
| 認証 | アプリケーションパスワード（WordPress 5.6以降）をBasic認証で送信。HTTPSを使う | [Authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/) |
| 検索 | `GET /wp/v2/posts` の `search` / `status` / `context=edit` | [Posts](https://developer.wordpress.org/rest-api/reference/posts/) |

## 実接続時に確かめること

資料からは確定できなかった点です。[テスト記録](04_テスト記録.md) の実接続テストで確認します。

- 記事1本あたりの所要時間（6分以内に収まるか）と実際の費用
- 文字数の条件を1回で満たす割合
- `sheetSafe_` の `'` の扱いが実シートでモックと同じか
- 対象サイトのWordPressのバージョン、セキュリティプラグイン、パーマリンク設定の影響
- 下書きの応答に含まれる `link` の形式
