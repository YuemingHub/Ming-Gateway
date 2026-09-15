# 部署状态

> 本文件记录**线上实际状态**，便于回看与回滚。不含任何密钥。
> 最后更新：2026-09-15

## 当前结论

网关已上线，七条验收全部通过，且**未影响同机上已有的其他站点**。

| 项 | 值 |
|---|---|
| 服务器 | `39.107.228.76`（阿里云 cn-beijing） |
| 对外入口 | `https://api.ymai.fun`（Nginx 反代，Let's Encrypt） |
| 落地路径 | `/opt/api-gateway` |
| 服务名 | `api-gateway.service`（systemd，enabled + active） |
| 上游监听 | `127.0.0.1:8787`（**只回环，不对公网暴露**） |
| 证书 | `/etc/letsencrypt/live/api.ymai.fun/`，仅此一域名，有效至 2026-12-14 |
| 常驻内存 | 约 12 MB |

## 上线时改过的两处配置

`/opt/api-gateway/gateway.yaml`（原始副本留在同目录 `gateway.yaml.bak`）：

- `server.auth.cookieSecure: false → true` —— 否则 HTTPS 下「密码对了、提示成功、又跳回登录页」
- `server.auth.trustProxy: false → true` —— 否则反代后所有外部来源被算成同一个 IP

两处都依赖 Nginx 真实传 `X-Forwarded-For`；已在 `api-gateway` 块的 `proxy_set_header` 中确认。

## 验收结果（2026-09-15，走公网实测）

1. `GET /healthz` → `{"ok":true,"version":"1.0.0"}`，HTTP 200
2. `GET /__gw/` → 302 跳登录页，页面内无任何状态数据
3. 用 `server.auth.username` + `.env` 的 `GATEWAY_ADMIN_PASSWORD` 登录 → 302 进状态页，右上角显示该用户名；会话 Cookie 带 `Secure`
4. 带 `GATEWAY_TOKEN_A` 调用 `/v1/chat/completions` → 200，响应头 `X-GW-Channel: opencode-go`
5. 不带令牌调用同一接口 → 401
6. `"stream": true` → 分块逐条到达（时间戳递增），非一次性吐出
7. 20 MB 请求体 → 413（Nginx 直接拒绝）

## 回滚

```bash
# 撤回对外入口（证书与 /opt/api-gateway 保留）
rm -f /etc/nginx/sites-enabled/api-gateway
nginx -t && systemctl reload nginx
systemctl disable --now api-gateway
```

## 变更记录

- 2026-09-15：管理面登录用户名由默认 `admin` 改为自定义值（见服务器 `gateway.yaml` 的 `server.auth.username`），密码仍由 `.env` 的 `GATEWAY_ADMIN_PASSWORD` 提供。改动前的 `gateway.yaml` 与 `.env` 已在服务器同目录留备份 `*.bak-20260915*`。密码值不入库、也不写进本文件。

## 尚未做的事

- 服务当前以 `root` 运行（沿用上线时指定的 unit 原文，未擅自改动）。改成专用账号属于权限模型变更，需另行确认后再做：新建系统账号、调整 `/opt/api-gateway` 属主权限、在 unit 中加 `User=` / `Group=` 并重启。此前尝试执行时被本机的安全策略拦下，未产生任何中间状态。
