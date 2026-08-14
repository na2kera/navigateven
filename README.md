# Route Planner

Even G2 スマートグラス向けの乗換ナビアプリ（Even Hub アプリ）。スマホ側で目的地を登録し、グラス側で目的地を選ぶと現在地からの公共交通経路を表示します。

## 構成

- `src/phone/` — スマホ側 UI（目的地の登録・編集）
- `src/glasses/` — グラス側 UI（目的地リスト → 経路候補 → 行程表示）
- `src/api/` — ジオコーディング（国土地理院 / Nominatim）と経路検索（transit.ls8h.com）
- `app.json` — Even Hub マニフェスト

## 開発

```bash
npm run dev        # Vite 開発サーバー
npm test           # テスト
npm run build      # 型チェック + ビルド（dist/）
npm run pack       # .ehpk にパッケージング
npm run simulate   # evenhub-simulator で起動
```
