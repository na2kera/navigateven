# 音声入力による目的地指定 — Whisper オンデバイス搭載の実現可能性調査

調査日: 2026-07-23
対象: NavigatEven (Even Hub アプリ / `@evenrealities/even_hub_sdk` 0.0.11)

## TL;DR(結論)

- **マイク入力自体は SDK 公式サポートあり。** `bridge.audioControl()` でグラス側/スマホ側マイクの PCM (16kHz / 16bit / mono) がそのまま取れるので、「音声 → 目的地テキスト → 既存のジオコーディング検索」というパイプラインは組める。
- **Whisper をアプリ(WebView)上にオンデバイスで載せるのは「技術的には可能だが、実用ラインに乗せるのは厳しい」。** ボトルネックはモデルサイズ(数十〜数百MB)、WebView での推論速度(マルチスレッド WASM・WebGPU がほぼ使えない)、そして日本語の地名・施設名に対する小型モデルの認識精度。
- **現実的な本命はクラウド STT(Whisper API 系)との組み合わせ。** SDK から取った PCM を WAV 化して API に投げる方式なら、追加は `app.json` の network whitelist 1 行+数百行の実装で済み、日本語精度も速度も桁違いに良い。
- 推奨: **STT を抽象インターフェースとして切り、まずクラウド STT で機能を出す。** オンデバイス化(whisper-tiny/base の WASM 実行)は PoC としては面白いが、本線には据えない。

---

## 1. 前提: NavigatEven の実行環境

Even Hub アプリは **Even 公式スマホアプリ内の WebView** で動く Web アプリ(Vite + TS)で、`.ehpk` にパッケージして配布する。つまり「モデルを載せる」場所はグラスではなくスマホの WebView。グラス側(G1/G2)は表示とマイク・タッチ入力のみで、計算資源としては使えない。

- iOS: WKWebView(WebKit)/ Android: システム WebView(Chromium)
- ネットワークは `app.json` の `permissions.network.whitelist` に載せたドメインのみ許可(現状: transit.ls8h.com / nominatim / GSI の 3 つ)
- ブラウザの `localStorage` は WebView 再起動で消えるという報告があり、永続化はホスト側 storage(`bridge.setLocalStorage`)経由が前提(本アプリの目的地保存も同方式)

## 2. SDK 側で確認できたこと(マイク入力は可能)

`@evenrealities/even_hub_sdk` 0.0.11 の型定義・README で確認:

```ts
import { AudioInputSource } from '@evenrealities/even_hub_sdk'

await bridge.audioControl(true, AudioInputSource.Glasses) // グラスのマイク ON
// または AudioInputSource.Phone(スマホのマイク)

const unsub = bridge.onEvenHubEvent(event => {
  const audio = event.audioEvent
  if (!audio) return
  audio.audioPcm // Uint8Array — PCM S16LE, 16kHz, mono
  audio.source   // 'glasses' | 'phone'
})

await bridge.audioControl(false) // OFF
```

- 音声フォーマットは **16kHz / signed 16bit LE / モノラル**、約 10ms 単位のフレームで `audioEvent` として届く(コミュニティの実機検証情報)。これは **Whisper の入力仕様(16kHz mono)とそのまま一致** しており、リサンプリング不要。
- グラス側マイクを使う場合は **先に startup page(グラス側 UI)を作っておく必要がある**(作らないと `audioControl` が `false` を返す)。本アプリは既に `initGlasses()` で作成済みなので条件は満たせる。
- 結果コードとして `APP_REQUEST_AUDIO_CTR_SUCCESS / FAILED` が定義されている。
- `app.json` の permissions にマイク用エントリ(現状 `location` / `network` を宣言しているのと同様)を追加する必要がある想定。

**→ 「音声を取る」部分に障害はない。問題は「どこで文字にするか」。**

## 3. オンデバイス Whisper(WebView 内実行)の評価

### 実行手段

WebView 内で Whisper を動かす既存手段は主に 2 つ:

| 手段 | 概要 |
|---|---|
| [transformers.js](https://huggingface.co/docs/transformers.js/index) + ONNX Runtime Web | `whisper-tiny/base/small` の量子化 ONNX を WASM/WebGPU で実行。[whisper-web](https://github.com/xenova/whisper-web) が実装例 |
| whisper.cpp の WASM ビルド | ggml 量子化モデルを WASM で実行。マルチスレッド前提の設計 |

### 制約 1: モデルサイズと配布

| モデル | 量子化後サイズ目安 | 日本語(地名・固有名詞)実用性 |
|---|---|---|
| whisper-tiny | 約 40MB (q8) | ほぼ使い物にならない |
| whisper-base | 約 80MB (q8) | 短い一般語彙なら可、固有名詞は厳しい |
| whisper-small | 約 190〜250MB | このあたりからやっと実用の入り口 |

- 手元の `evenhub-cli` 0.1.13 の pack 処理には **クライアント側のサイズ上限チェックは見当たらなかった** が、公式の提出ガイドライン(hub.evenrealities.com/docs/reference/app-submission)は本調査環境からアクセスできず未確認。数十MB のモデルを `.ehpk` に同梱する配布は、審査・DL 体験の面でいずれにせよ非現実的。
- 現実には **初回起動時に Hugging Face 等からランタイム DL** する構成になるが、それには whitelist へ `huggingface.co` + CDN ドメインの追加が必要で、かつ WebView の Cache API / IndexedDB が **どこまで永続するか未検証**(localStorage が揮発する環境なので、モデル 40〜200MB を再 DL させられるリスクがある)。ホスト storage API はこのサイズのバイナリ保存を想定していない。

### 制約 2: 推論速度(ここが最大の壁)

- **マルチスレッド WASM は期待できない。** SharedArrayBuffer には COOP/COEP ヘッダによる cross-origin isolation が必要で、`.ehpk` 配信(ホストアプリが内部で serve)ではヘッダを制御できない。→ シングルスレッド WASM 前提。
- **WebGPU もほぼ期待できない。** WebGPU なら WASM 比 5〜10 倍速との報告があるが、[Android WebView / iOS WKWebView では WebGPU はデフォルトで使えない](https://web.dev/blog/webgpu-supported-major-browsers)(iOS 26 の Safari では有効化されたが、WKWebView での挙動は[未サポート報告あり](https://developer.apple.com/forums/thread/781602))。
- シングルスレッド WASM のスマホ実行では、**3〜5 秒の発話の書き起こしに tiny でも数秒〜十数秒、base 以上では数十秒** かかるのが実情。「グラスに向かって目的地を言う → すぐ検索」という UX には遠い。
- WKWebView はメモリ上限が厳しく(目安 1GB 前後で kill)、small 以上はロード自体がリスク。

### 制約 3: 日本語の目的地認識という要件

本アプリの入力は「渋谷ヒカリエ」「六本木ヒルズ森タワー」のような **固有名詞1発認識** で、誤字が 1 文字でもあるとジオコーディング(GSI / Nominatim)が外れる。tiny/base クラスの多言語モデルの日本語 CER ではこの用途を満たせない。日本語特化の kotoba-whisper 等は精度が高いが distil-large-v3 ベース(1.5GB 級)で WebView には載らない。Vosk 日本語 small(約 48MB, vosk-browser で WASM 実行可)という代替もあるが、固有名詞精度は同様に厳しい。

### オンデバイス評価まとめ

> **PoC としては成立する(whisper-tiny/base + transformers.js、モデルはランタイム DL)。ただし「言ったら数秒で正しい目的地が出る」という製品品質には、モデルサイズ・速度・精度の 3 点すべてで届かない。**

## 4. 現実的な代替案: SDK マイク + クラウド STT

PCM は既に手元にあるので、WAV ヘッダを付けて STT API に POST するだけでよい:

```
audioControl(ON) → audioEvent の PCM を蓄積(タップで開始/終了 or 無音検出)
→ WAV 化(16kHz mono、10 秒でも ~320KB)
→ STT API → テキスト → 既存 searchPlaces()(geocode.ts)→ 目的地登録
```

| 案 | 精度(日本語固有名詞) | 応答 | コスト | 備考 |
|---|---|---|---|---|
| OpenAI `gpt-4o-mini-transcribe` | ◎ | ~1 秒 | $0.003/分 | 本命。Whisper 系で最安 |
| OpenAI `whisper-1` (Whisper API) | ○ | ~1-2 秒 | $0.006/分 | 「OpenAI の Whisper を使う」ならこれ |
| Google STT v2 / Deepgram 等 | ◎ | ~1 秒 | 同水準 | ストリーミング対応 |
| オンデバイス whisper-tiny/base | △〜✕ | 数秒〜数十秒 | 0 | オフライン動作のみが利点 |

必要な変更:

1. `app.json` の network whitelist に STT エンドポイントを追加(例: `https://api.openai.com`)。
2. **API キーをクライアントに埋め込まない。** `.ehpk` は静的 Web アプリなのでキーは抽出可能。乗換 API(transit.ls8h.com)同様に **自前の中継プロキシ**を 1 本立て、whitelist にはプロキシのドメインを載せるのが正攻法。
3. STT を `interface SpeechToText { transcribe(pcm: Uint8Array): Promise<string> }` として切っておけば、将来 WebView の WebGPU 対応が進んだ時点でオンデバイス実装に差し替え可能。

補足: WebView 内では Web Speech API(`SpeechRecognition`)は WKWebView / Android WebView とも利用不可のため、「OS の音声認識をタダ乗り」する道はない。Even ホストアプリ自体の音声機能(Even AI)も SDK には公開されていない(型定義に該当 API なし)。

## 5. 推奨と次のアクション

1. **フェーズ 1(推奨・実装可能)**: グラスマイク → クラウド STT(gpt-4o-mini-transcribe または whisper-1)→ `searchPlaces()`。中継プロキシ込みで小規模な実装。
2. **フェーズ 2(任意・実験)**: transformers.js + whisper-base(q8, ランタイム DL)を同じ STT インターフェース裏に実装し、実機(iOS/Android 両方)で速度・精度・モデルキャッシュ持続性を計測。
3. **実機で要確認の残項目**:
   - `audioControl` 使用時に `app.json` へ追加すべき permission 名(公式 docs で確認)
   - `.ehpk` の公式サイズ上限(App Submission & QA Guidelines — 本調査環境からは閲覧不可だった)
   - WebView での Cache API / IndexedDB の永続性、WKWebView の WebGPU 可否

## 参考リンク

- [Even Hub SDK (npm)](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) — `audioControl` / `AudioEvent` の公式 API
- [Even Hub Docs — CLI](https://hub.evenrealities.com/docs/reference/cli) / [App Submission & QA Guidelines](https://hub.evenrealities.com/docs/reference/app-submission)
- [even-g2-notes (コミュニティ実機検証)](https://github.com/nickustinov/even-g2-notes) — PCM 16kHz S16LE mono・localStorage 揮発の報告
- [whisper-web (transformers.js での Whisper ブラウザ実行例)](https://github.com/xenova/whisper-web) / [transformers.js WebGPU vs WASM 性能報告](https://github.com/huggingface/transformers.js/issues/894)
- [WebGPU のブラウザ対応状況 (web.dev)](https://web.dev/blog/webgpu-supported-major-browsers) / [WKWebView での WebGPU 未対応報告 (Apple Developer Forums)](https://developer.apple.com/forums/thread/781602)
