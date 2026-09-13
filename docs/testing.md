# テスト手順(Phase 2)

## 0. 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `CRON_SECRET` | ○ | 16文字以上。`openssl rand -hex 32` などで生成 |
| `FRED_API_KEY` | ○ | 未設定の場合、FRED の指標(米10年・米2年・スプレッド・VIX)は「取得できませんでした」になる |
| `LINE_CHANNEL_ACCESS_TOKEN_ACADEMY` | ○ | `validate` と実配信で使う。未設定なら 500 を返し、LINE は呼ばない |
| `MARKET_ROUTINE_URL` | – | 省略時は `https://market-routine.vercel.app/` |
| `ENABLE_LICENSED_INDICES` | – | `true` のときだけ株価指数を配信する(許諾の取得後に設定) |

ローカルでは `.env.local` に書く(`.gitignore` 済み)。値をチャット・コミット・ログに貼らないこと。

## 1. 自動テスト(キー不要)

```bash
npm test
```

外部 API はすべてモックしてあり、実際の通信や配信は行わない。確認している内容:

| 分類 | 確認内容 |
|---|---|
| 認証 | ヘッダーなし / `Bearer undefined` / 誤ったトークン / scheme なし → 拒否。`CRON_SECRET` が未設定・空・16文字未満 → すべて拒否 |
| 表示 | JST の日付変換(22:00 UTC → 翌日)、bp・%・差分の表示、±0 の判定(浮動小数の誤差を含む) |
| 財務省 CSV | Shift_JIS のデコード、和暦の変換、欠損値のスキップ、月初に全期間 CSV で補うこと |
| 一部失敗 | FRED が 500 → 該当する4行が「取得できませんでした」になり、残りの指標でカードを配信 |
| 全部失敗 | 全ソースがネットワークエラー → テキストのフォールバックを配信 |
| キー未設定 | `FRED_API_KEY` 未設定 → FRED を呼ばず、該当する行を失敗扱いにする |
| LINE | 5xx → 同じリトライキーで再試行 / 409 → `already_sent` / 4xx → 502 / トークン未設定 → 500 |
| 検証モード | `?validate=1` は検証 API だけを呼び、broadcast は呼ばない |
| 機密情報 | レスポンスとログに `CRON_SECRET`・FRED キー・LINE トークンが含まれないこと |

## 2. ローカルでの手動テスト

`.env.local` を用意する(値は各自で入力)。

```bash
cp .env.example .env.local
```

開発サーバーを起動する。

```bash
npm run dev
```

別のターミナルで、以下の順に確認する。`scripts/cron-request.sh` は `.env.local` から `CRON_SECRET` を読み込み、画面には表示しない。

1. 認証なしのリクエストが 401 になること

```bash
scripts/cron-request.sh unauthorized
```

2. dryRun: 実データでカードの JSON を確認する(LINE は呼ばない)。`indicators` がすべて `ok: true` になり、`fallback: false` であること。

```bash
scripts/cron-request.sh dry-run
```

3. validate: LINE の検証 API で Flex Message が仕様に合っているかを確認する(配信しない、通数も消費しない)。`"valid": true` で HTTP 200 になること。

```bash
scripts/cron-request.sh validate
```

4. 見た目の確認(任意): dryRun の `messages[0].contents` を [Flex Message Simulator](https://developers.line.biz/flex-simulator/) に貼り付けて表示を確認する。

> ローカルからの実配信(`broadcast`)は友だち全員に届くため、行わないこと。実配信のテストは次の Preview 環境で、テスト用チャネルを使って行う。

## 3. Preview 環境でのテスト

Vercel Cron は **本番デプロイでしか実行されない** ため、Preview 環境では手動で呼び出す。

### 3-1. 環境変数を設定する

値は対話プロンプトで入力する(シェルの履歴に残らない)。

```bash
vercel env add CRON_SECRET preview
```

```bash
vercel env add FRED_API_KEY preview
```

```bash
vercel env add LINE_CHANNEL_ACCESS_TOKEN_ACADEMY preview
```

**推奨**: Preview 環境の `LINE_CHANNEL_ACCESS_TOKEN_ACADEMY` には、本番の ACADEMY チャネルではなく、スタッフだけが友だちになっている **テスト用の LINE 公式アカウント** のトークンを設定する。こうすると Preview で実配信まで安全に試せる。

### 3-2. デプロイして呼び出す

```bash
vercel deploy
```

Deployment Protection が有効な場合は、Vercel の Settings → Deployment Protection → Protection Bypass for Automation でシークレットを発行し、`VERCEL_AUTOMATION_BYPASS_SECRET` として環境変数に設定してから呼び出す。`CRON_SECRET` も Preview 用の値を環境変数に設定しておく(設定されていれば `.env.local` は読み込まない)。

```bash
scripts/cron-request.sh unauthorized https://<preview-url>
```

```bash
scripts/cron-request.sh validate https://<preview-url>
```

テスト用チャネルを設定した場合のみ、実配信を試す(実行前に確認プロンプトが出る)。

```bash
scripts/cron-request.sh broadcast https://<preview-url>
```

確認すること:
- 通知に `altText`(`9/14(月) 本日のマーケットルーティン|…`)が表示される
- カードの色(プラスは緑、マイナスは赤)、基準日、「詳しく見る」のリンク先
- 同じ日にもう一度実行すると `"status": "already_sent"` になり、2通目は届かない

## 4. 本番環境

1. `vercel env add <NAME> production` で3つの環境変数を設定する(`CRON_SECRET` は Preview と別の値にする)
2. 本番デプロイ後、Vercel の Settings → Cron Jobs に `/api/cron/line-market-summary`(`0 22 * * 0-4`)が登録されていることを確認する
3. 本番でも `validate` で最終確認する(`scripts/cron-request.sh validate https://<本番URL>`)
4. 初回の配信後、Vercel の Logs で `[line-market-summary] broadcast {"status":"sent",...}` を確認する

> Cron Jobs 画面の「Run」ボタンは実配信になる(友だち全員に届く)ので注意する。

## 5. エラー時の挙動

| 状況 | 配信内容 | HTTP | ログ |
|---|---|---|---|
| 認証失敗 / `CRON_SECRET` 未設定 | なし | 401 | 未設定時のみ `[auth] CRON_SECRET is not configured` |
| 一部の指標の取得に失敗 | カード(該当する行は「取得できませんでした」) | 200 | `indicator fetch failed [...]` |
| 全指標の取得に失敗 | テキストのフォールバック + サイトへのリンク | 200 | `indicator fetch failed [...]` |
| LINE トークン未設定 | なし | 500 | `LINE_CHANNEL_ACCESS_TOKEN_ACADEMY is not set` |
| LINE が 5xx / タイムアウト | 同じリトライキーで最大2回再試行 | 200 または 502 | 失敗時は `broadcast failed LINE broadcast: HTTP ...` |
| LINE が 4xx(トークン無効・通数上限など) | なし | 502 | `broadcast failed LINE broadcast: HTTP 4xx {LINE のエラー内容}` |
| 同じ日に2回目の実行 | なし(LINE 側で重複として弾かれる) | 200 `already_sent` | `broadcast {"status":"already_sent"}` |

## 6. 運用上の注意

- **同じ日の再配信はできない**: リトライキーは JST の日付ごとに決まるため、フォールバックのテキストが送られた日に、データが復旧してから送り直すことはできない(24時間は LINE 側で弾かれる)。
- **配信時刻**: Hobby プランでは 07:00〜07:59 のどこかで実行される。
- **通数**: 1回の配信で「友だち数」通を消費する。月間の上限を超えると LINE から 429 が返り、上の表の「LINE が 4xx」と同様に 502 になる。
- **失敗の通知**: 現状、失敗は Vercel のログに出るだけ。見落としを防ぐには、Vercel の Log Drains やアラート機能と連携する必要がある。
