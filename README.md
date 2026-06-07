# 关注墙 (following-wall)

瓜瓜的关注合集首页:一张瀑布流网页,每个卡片是关注的一位创作者,自动显示该创作者的**最新一期**内容。

## 当前覆盖

| 平台 | 状态 | 数量 |
|---|---|---|
| B 站 | ✅ MVP | 4 |
| YouTube | ⏳ 占位 | 0 |
| Substack | ⏳ 占位 | 0 |

## 工作原理

```
subscriptions.json   ← 瓜瓜在这里加/删关注
        │
        ▼
GitHub Actions (每天北京时间 23:00)
        │
        ▼
node scripts/fetch-all.mjs
        │
        ▼
data.json (被 Actions commit 回仓库)
        │
        ▼
index.html ← 用户访问 GitHub Pages,前端 fetch data.json 渲染
```

整套方案 **零运行成本**:GitHub 仓库免费、Actions 每月有 2000 分钟免费额度(本项目每天用不到 1 分钟)、Pages 免费托管。

## 怎么用

### 增加 / 删除关注

直接编辑 `subscriptions.json`,然后 push 到仓库。下次 Actions 触发时会生效。

每个平台的字段:
- **bilibili**: `{ "name": "显示名", "uid": "数字 UID" }`
   - 数字 UID 来自 UP 主主页 URL `https://space.bilibili.com/123456` 里的那个数字
   - 如果手上只有 `b23.tv/xxxx` 短链:`curl -sIL https://b23.tv/xxxx | grep -oE 'space.bilibili.com/[0-9]+'`
- **youtube**: `{ "name": "显示名", "channelId": "UCxxxxxx" }`(尚未实现)
- **substack**: `{ "name": "显示名", "subdomain": "xxx" }` 对应 `https://xxx.substack.com`(尚未实现)

### 手动触发一次

GitHub 仓库 → Actions tab → "Update feeds" → "Run workflow"

### 本地预览

```bash
# 1) 先把 data.json 跑出来(本地 IP 抓 B站 可能失败,见 troubleshooting)
node scripts/fetch-all.mjs

# 2) 起个本地 HTTP 服务(双击 HTML 文件不行,fetch 会被拦)
python3 -m http.server 8000
# → 浏览器访问 http://localhost:8000
```

## 部署 (GitHub Pages)

1. 在 GitHub 上 push 这个仓库到 `https://github.com/guaguasis-astro/following-wall`
2. Settings → Pages → Source: `Deploy from a branch`,Branch: `main`,目录 `/ (root)`
3. 等几分钟,访问 `https://guaguasis-astro.github.io/following-wall/`

## Troubleshooting

### 本地跑 `fetch-all.mjs` 时 B站 全部失败
正常 —— B站 对家用宽带 IP 的反爬比较严,常见错误 `-352 风控校验失败` 或 `-799 频率限制`。
脚本本身有 3 条降级路径(WBI 签名 → 动态 feed → RSSHub),GitHub Actions 的云端 IP 段通常能跑通至少一条。
**最稳的验证方式是在 GitHub 上手动触发一次 workflow。**

### 某个 UP 主当天没更新出来
没事 —— 脚本会把上一轮 `data.json` 里那个创作者的旧数据保留下来,并打上"未更新"小角标。
连续多天看到角标就说明那条策略失效了,再来修。

### Substack/YouTube 怎么加
等瓜瓜把 channel ID 和 publication subdomain 凑齐,告诉我,我就把对应 fetcher 实现起来。两个平台都是开放 RSS,代码量很小。
