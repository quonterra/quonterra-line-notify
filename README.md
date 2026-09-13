# QUONTERRA ACADEMY LINE Notify

毎朝(平日 07:00 JST)、主要な相場指標のサマリーを QUONTERRA ACADEMY 公式 LINE の友だち全員に Flex Message で配信する Next.js / Vercel プロジェクト。

- エンドポイント: `GET /api/cron/line-market-summary`(Vercel Cron、`CRON_SECRET` による Bearer 認証)
- データソース: FRED(米国債利回り・VIX)、ECB 参照レート(ドル円)、財務省(日本10年国債)
- 株価指数(日経平均・NYダウ・S&P500・NASDAQ)は配信許諾の取得後に `ENABLE_LICENSED_INDICES=true` で有効化

## ドキュメント

- [設計(Phase 0)](docs/phase0-design.md)
- [テスト手順](docs/testing.md)
- 環境変数: [.env.example](.env.example)

## 開発

```bash
npm install
npm test
npm run dev
```
