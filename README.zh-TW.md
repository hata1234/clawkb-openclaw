# clawkb-openclaw

**多實例 ClawKB 自動召回 Plugin — 適用於 OpenClaw**

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

在每次使用者訊息時自動搜尋一個或多個 [ClawKB](https://github.com/hata1234/clawkb) 知識庫伺服器，並將最相關的結果注入 AI 助理的系統上下文中 — 讓你的 AI 助理即時回憶個人或團隊知識，無需手動檢索。

---

## 主要功能

- **多實例** — 同時連接任意數量的 ClawKB 伺服器
- **按發送者分配 Token** — 每位使用者（Telegram、Discord、LINE、WhatsApp…）對應各自的 API Token，權限由伺服器端控制
- **預設 Token** — 公開知識庫無需映射即可供所有人查詢
- **僅伺服器端 ACL** — 不做客戶端過濾；使用者能看到什麼完全取決於 API Token 和 ClawKB 伺服器權限
- **並行查詢** — 所有實例同時查詢；單一實例失敗不會阻塞其他查詢
- **可設定觸發方式** — 永遠搜尋、僅問句搜尋、或關鍵字觸發
- **優雅降級** — 逾時和錯誤按實例記錄並靜默跳過

---

## 安裝

將此目錄複製或建立符號連結至 OpenClaw extensions 資料夾：

```bash
# 方式 A：符號連結（開發推薦）
ln -s /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw

# 方式 B：複製
cp -r /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw
```

然後重新載入 OpenClaw（或重啟 Gateway）。

---

## 設定

在 OpenClaw `config.json` 的 `plugins.entries` 中加入：

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

### 實例屬性

| 屬性 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一識別碼，用於結果標籤（`[home#23]`） |
| `label` | string | — | 易讀的標籤名稱 |
| `url` | string | ✅ | ClawKB 基礎 URL |
| `defaultToken` | string \| null | — | 未映射的發送者使用此 Token。公開知識庫可設定。 |
| `senderTokenMap` | object | — | 發送者 ID → API Token 映射 |

### Plugin 層級選項

| 選項 | 預設值 | 說明 |
|------|--------|------|
| `trigger` | `"always"` | `always` \| `question` \| `keyword` |
| `keywords` | `[]` | 觸發關鍵字（僅 `trigger="keyword"` 時使用） |
| `topK` | `5` | 每個實例最多回傳幾筆結果 |
| `threshold` | `0.3` | 最低相似度分數（0–1） |
| `timeoutMs` | `500` | 每個實例的請求逾時（毫秒） |
| `inject` | `"summary"` | `summary` \| `content` \| `full` |
| `maxTokens` | `800` | 注入的大約最大 Token 數 |

---

## 運作原理

1. **`before_prompt_build` hook** 在每次 Prompt 發送給 LLM 之前觸發
2. 從 OpenClaw 中繼資料標頭中擷取發送者 ID（支援 Telegram、Discord、LINE、WhatsApp）
3. 對每個實例解析要使用的 API Token：
   - `senderTokenMap[senderId]` → 使用對應 Token
   - 無匹配 + 已設定 `defaultToken` → 使用預設 Token
   - 兩者皆無 → 跳過此實例
4. 所有符合條件的實例透過 `POST /api/search` **並行查詢**
5. 結果合併、門檻過濾、按相似度降序排列
6. 格式化結果以 `appendSystemContext` 注入

### 注入格式

```
--- ClawKB Knowledge (auto-recalled) ---
[Home KB#23] 伺服器架設指南 — 安裝 Docker 並執行 compose stack…
[Home KB#41] API 參考文件 — 文章、搜尋和 Token 的 REST 端點…
---
```

---

## 指令

### `/clawkb status`
顯示 Plugin 設定、實例列表和上次搜尋統計。

### `/clawkb test <query>`
使用你的發送者 Token 對所有設定的實例執行測試搜尋，並顯示格式化結果。

### `/clawkb instances`
列出所有設定的實例及發送者數量和預設 Token 狀態。

---

## 存取控制

**所有 ACL 由 ClawKB 伺服器端處理。** Plugin 不過濾結果 — 它只傳送正確的 API Token，伺服器根據綁定的使用者、群組和集合權限回傳允許查看的內容。

授予使用者存取權限：
1. 在 ClawKB 中建立具有適當權限的 API Token
2. 將使用者的發送者 ID → Token 映射加入 `senderTokenMap`

撤銷存取權限：移除映射或在 ClawKB 中作廢 Token。

---

## 支援平台

發送者 ID 擷取已測試：
- **Telegram** — 數字用戶 ID
- **Discord** — Snowflake ID
- **LINE** — LINE 用戶 ID 字串
- **WhatsApp** — 電話號碼

---

## 授權條款

AGPL-3.0 — 見 [LICENSE](LICENSE)
