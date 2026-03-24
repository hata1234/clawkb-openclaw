# clawkb-openclaw

**マルチインスタンス ClawKB 自動リコール Plugin — OpenClaw 用**

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **日本語**

ユーザーメッセージごとに1つ以上の [ClawKB](https://github.com/hata1234/clawkb) ナレッジベースサーバーを自動検索し、最も関連性の高い結果をAIアシスタントのシステムコンテキストに注入します — 手動検索なしで、個人やチームのナレッジを即座に呼び出せます。

---

## 主な機能

- **マルチインスタンス** — 任意の数の ClawKB サーバーに同時接続
- **送信者ごとの Token マッピング** — 各ユーザー（Telegram、Discord、LINE、WhatsApp…）が独自の API Token にマッピングされ、権限はサーバー側で制御
- **デフォルト Token** — 公開ナレッジベースはマッピングなしで誰でもクエリ可能
- **サーバー側 ACL のみ** — クライアント側フィルタリングなし。ユーザーに表示される内容は API Token と ClawKB サーバーの権限設定のみで決定
- **並列クエリ** — すべてのインスタンスに同時クエリ。1つの障害が他をブロックしない
- **トリガー設定可能** — 常時検索、質問時のみ、またはキーワードトリガー
- **グレースフルデグラデーション** — タイムアウトとエラーはインスタンスごとにログされ、サイレントにスキップ

---

## インストール

このディレクトリを OpenClaw extensions フォルダにコピーまたはシンボリックリンク：

```bash
# 方法 A：シンボリックリンク（開発推奨）
ln -s /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw

# 方法 B：コピー
cp -r /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw
```

その後、OpenClaw をリロード（または Gateway を再起動）してください。

---

## 設定

OpenClaw の `config.json` の `plugins.entries` に追加：

```json
{
  "clawkb-openclaw": {
    "config": {
      "instances": [
        {
          "id": "home",
          "label": "Home KB",
          "url": "http://localhost:3500",
          "defaultToken": null,
          "senderTokenMap": {
            "123456789": "clawkb_tok_alice_full",
            "987654321": "clawkb_tok_bob_readonly"
          }
        }
      ],
      "trigger": "always",
      "topK": 5,
      "threshold": 0.3,
      "timeoutMs": 500,
      "inject": "summary",
      "maxTokens": 800
    }
  }
}
```

### インスタンスプロパティ

| プロパティ | 型 | 必須 | 説明 |
|------------|------|------|------|
| `id` | string | ✅ | 一意の識別子。結果ラベルに使用（`[home#23]`） |
| `label` | string | — | 人間が読みやすいラベル名 |
| `url` | string | ✅ | ClawKB ベース URL |
| `defaultToken` | string \| null | — | マッピングされていない送信者用の Token。公開 KB 向け。 |
| `senderTokenMap` | object | — | 送信者 ID → API Token マッピング |

### Plugin レベルオプション

| オプション | デフォルト | 説明 |
|------------|------------|------|
| `trigger` | `"always"` | `always` \| `question` \| `keyword` |
| `keywords` | `[]` | トリガーキーワード（`trigger="keyword"` 時のみ） |
| `topK` | `5` | インスタンスごとの最大結果数 |
| `threshold` | `0.3` | 最小類似度スコア（0–1） |
| `timeoutMs` | `500` | インスタンスごとのリクエストタイムアウト（ミリ秒） |
| `inject` | `"summary"` | `summary` \| `content` \| `full` |
| `maxTokens` | `800` | 注入する概算最大トークン数 |

---

## 動作原理

1. **`before_prompt_build` hook** が LLM へのプロンプト送信前に毎回発火
2. OpenClaw メタデータヘッダーから送信者 ID を抽出（Telegram、Discord、LINE、WhatsApp 対応）
3. 各インスタンスに対して使用する API Token を解決：
   - `senderTokenMap[senderId]` → 対応する Token を使用
   - マッチなし + `defaultToken` 設定済み → デフォルト Token を使用
   - いずれもなし → このインスタンスをスキップ
4. 対象の全インスタンスに `POST /api/search` で**並列クエリ**
5. 結果をマージ、閾値フィルタリング、類似度降順でソート
6. フォーマットされた結果を `appendSystemContext` として注入

### 注入フォーマット

```
--- ClawKB Knowledge (auto-recalled) ---
[Home KB#23] サーバー構築ガイド — Docker をインストールして compose stack を実行…
[Home KB#41] API リファレンス — エントリ、検索、Token の REST エンドポイント…
---
```

---

## コマンド

### `/clawkb status`
Plugin 設定、インスタンスリスト、最終検索統計を表示。

### `/clawkb test <query>`
送信者の Token を使用して全インスタンスにテスト検索を実行し、フォーマットされた結果を表示。

### `/clawkb instances`
設定されたすべてのインスタンスの送信者数とデフォルト Token ステータスを表示。

---

## アクセス制御

**すべての ACL は ClawKB サーバー側で処理されます。** Plugin は結果をフィルタリングしません — 正しい API Token を送信するだけで、サーバーがバインドされたユーザー、グループ、コレクション権限に基づいて閲覧可能な内容のみを返します。

ユーザーにアクセス権を付与：
1. ClawKB で適切な権限を持つ API Token を作成
2. ユーザーの送信者 ID → Token マッピングを `senderTokenMap` に追加

アクセス権を取り消す：マッピングを削除するか、ClawKB で Token を無効化。

---

## 対応プラットフォーム

送信者 ID の抽出テスト済み：
- **Telegram** — 数値ユーザー ID
- **Discord** — Snowflake ID
- **LINE** — LINE ユーザー ID 文字列
- **WhatsApp** — 電話番号

---

## ライセンス

AGPL-3.0 — [LICENSE](LICENSE) を参照
