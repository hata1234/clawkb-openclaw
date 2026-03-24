# clawkb-openclaw

**多实例 ClawKB 自动召回 Plugin — 适用于 OpenClaw**

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [日本語](README.ja.md)

在每次用户消息时自动搜索一个或多个 [ClawKB](https://github.com/hata1234/clawkb) 知识库服务器，并将最相关的结果注入 AI 助理的系统上下文中 — 让你的 AI 助理即时回忆个人或团队知识，无需手动检索。

---

## 主要功能

- **多实例** — 同时连接任意数量的 ClawKB 服务器
- **按发送者分配 Token** — 每位用户（Telegram、Discord、LINE、WhatsApp…）对应各自的 API Token，权限由服务器端控制
- **默认 Token** — 公开知识库无需映射即可供所有人查询
- **仅服务器端 ACL** — 不做客户端过滤；用户能看到什么完全取决于 API Token 和 ClawKB 服务器权限
- **并行查询** — 所有实例同时查询；单一实例失败不会阻塞其他查询
- **可配置触发方式** — 始终搜索、仅问句搜索、或关键字触发
- **优雅降级** — 超时和错误按实例记录并静默跳过

---

## 安装

将此目录复制或创建符号链接至 OpenClaw extensions 文件夹：

```bash
# 方式 A：符号链接（开发推荐）
ln -s /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw

# 方式 B：复制
cp -r /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw
```

然后重新加载 OpenClaw（或重启 Gateway）。

---

## 配置

在 OpenClaw `config.json` 的 `plugins.entries` 中添加：

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

### 实例属性

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识符，用于结果标签（`[home#23]`） |
| `label` | string | — | 易读的标签名称 |
| `url` | string | ✅ | ClawKB 基础 URL |
| `defaultToken` | string \| null | — | 未映射的发送者使用此 Token。公开知识库可设置。 |
| `senderTokenMap` | object | — | 发送者 ID → API Token 映射 |

### Plugin 级别选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `trigger` | `"always"` | `always` \| `question` \| `keyword` |
| `keywords` | `[]` | 触发关键字（仅 `trigger="keyword"` 时使用） |
| `topK` | `5` | 每个实例最多返回几条结果 |
| `threshold` | `0.3` | 最低相似度分数（0–1） |
| `timeoutMs` | `500` | 每个实例的请求超时（毫秒） |
| `inject` | `"summary"` | `summary` \| `content` \| `full` |
| `maxTokens` | `800` | 注入的大约最大 Token 数 |

---

## 工作原理

1. **`before_prompt_build` hook** 在每次 Prompt 发送给 LLM 之前触发
2. 从 OpenClaw 元数据头中提取发送者 ID（支持 Telegram、Discord、LINE、WhatsApp）
3. 对每个实例解析要使用的 API Token：
   - `senderTokenMap[senderId]` → 使用对应 Token
   - 无匹配 + 已设置 `defaultToken` → 使用默认 Token
   - 两者皆无 → 跳过此实例
4. 所有符合条件的实例通过 `POST /api/search` **并行查询**
5. 结果合并、阈值过滤、按相似度降序排列
6. 格式化结果以 `appendSystemContext` 注入

### 注入格式

```
--- ClawKB Knowledge (auto-recalled) ---
[Home KB#23] 服务器搭建指南 — 安装 Docker 并运行 compose stack…
[Home KB#41] API 参考文档 — 文章、搜索和 Token 的 REST 端点…
---
```

---

## 命令

### `/clawkb status`
显示 Plugin 配置、实例列表和上次搜索统计。

### `/clawkb test <query>`
使用你的发送者 Token 对所有配置的实例执行测试搜索，并显示格式化结果。

### `/clawkb instances`
列出所有配置的实例及发送者数量和默认 Token 状态。

---

## 访问控制

**所有 ACL 由 ClawKB 服务器端处理。** Plugin 不过滤结果 — 它只传送正确的 API Token，服务器根据绑定的用户、分组和集合权限返回允许查看的内容。

授予用户访问权限：
1. 在 ClawKB 中创建具有适当权限的 API Token
2. 将用户的发送者 ID → Token 映射添加到 `senderTokenMap`

撤销访问权限：移除映射或在 ClawKB 中作废 Token。

---

## 支持平台

发送者 ID 提取已测试：
- **Telegram** — 数字用户 ID
- **Discord** — Snowflake ID
- **LINE** — LINE 用户 ID 字符串
- **WhatsApp** — 电话号码

---

## 许可证

AGPL-3.0 — 见 [LICENSE](LICENSE)
