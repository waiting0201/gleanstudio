---
name: parity-check
description: 執行前台 parity 比對，並判斷差異是真的回歸還是內容漂移。當要驗證移植結果、擷取或更新 golden 基準、或看到 parity 失敗不知道該不該重新 baseline 時使用。
---

# Parity 比對

正式站 `https://gleanstudio.com.tw` 是活的，**它就是 oracle**。不需要跑舊程式碼，也不該從 Razor 原始碼推理期望輸出。

完整方法論見 [docs/08-verification.md](../../../docs/08-verification.md)。這個 skill 講的是操作與判斷。

## 執行

```bash
npm run preview                # ⚠️ 一定要用 preview，不是 dev
npm run parity                 # 全部 fixture
npm run parity -- /Home/About  # 單頁
```

`astro dev` 在資產服務與 HTML 輸出上與實際 build 的 Worker 不同。**任何 parity 宣稱都必須用 `npm run preview`。**

## 三層

| 層 | 內容 | 是否 gating |
|---|---|---|
| **A** byte | CRLF 正規化後逐 byte | 否 —— 回報但不擋 PR |
| **B** DOM | parse5 解析、排序屬性、收斂空白 | **是** |
| **C** 視覺 | Playwright 375/768/1440 + pixelmatch ≤0.1% | 手動跑，不進 CI |

## 判斷：真回歸 還是 內容漂移

**這是最容易做錯的一步。** 依序問：

### 1. 資料 hash 對得上嗎

`tests/golden/manifest.json` 記錄了擷取當下的資料庫匯出 SHA-256。**對不上就不要比對** —— parity runner 應該直接拒絕，而不是吐一堆假失敗。

對不上代表本機資料與 golden 不同源。先重新同步資料，或重新擷取 golden。

### 2. 差異的形狀是什麼

| 徵狀 | 判定 |
|---|---|
| 只有一頁差異，且是文字內容（標題、日期、圖檔名） | **內容漂移** —— 編輯者發佈了新內容 |
| 多頁同時出現同樣的結構差異（少了 class、標籤巢狀不同） | **真回歸** —— 多半在共用元件 |
| 只有空白與換行 | `compressHTML: false` 沒設，或縮排沒對齊 |
| 只有屬性順序 | Level A 會抓到、Level B 不會。通常可接受 |
| 分頁區塊差異 | 先讀 [docs/03-url-contract.md](../../../docs/03-url-contract.md) §5.1，那些不對稱是刻意的 |
| 日期是中文月份 | **真回歸** —— 用了 zh-TW 格式化。必須是 `20 July 2026` |
| 文章順序不同 | 檢查 `ImportSeq`（[docs/04-data-model.md](../../../docs/04-data-model.md) §5） |

### 3. 正式站現在長什麼樣

```bash
curl -s "https://gleanstudio.com.tw/Home/Articles?p=2" > /tmp/live.html
diff <(sed 's/\r$//' tests/golden/home-articles-p2.html) /tmp/live.html
```

**正式站與 golden 有差 → 內容漂移。正式站與 golden 相同、本機不同 → 真回歸。**

這一步是決定性的，不確定時就跑它。

## 重新 baseline

**只有在確認是內容漂移之後才做，而且是一次刻意的 commit。**

```bash
npm run golden
```

規則：

- **絕對不要**自動覆寫 golden。自動覆寫等於沒有基準
- golden 與資料庫匯出**必須同一 session 擷取**，這樣 manifest 的資料 hash 才有意義
- commit message 要寫清楚是什麼內容變動觸發的（例：`golden: 重新擷取 —— 新增文章 96aaa3f5`）
- 重新 baseline 之後把完整 parity 再跑一次，確認回到全綠

## 已知無法比對的

- **`POST /Home/Contact`** —— 不能對正式站發 POST（會寄真信、燒 reCAPTCHA 配額）。期望輸出手工推導後放 `tests/derived/`，由人審閱
- **錯誤頁** —— 舊站不存在的 `ArticleID` 回 500 黃頁，新站刻意回 404。這是[刻意分歧](../../../docs/09-known-issues.md) 4.1，不是失敗
- **小寫資源路徑** —— Workers Assets 大小寫敏感（Phase 3 已實測），接受落差，見 [docs/08-verification.md](../../../docs/08-verification.md) §5.4

## 接受一個差異

`scripts/parity-diff.mjs` 有兩種機制，**不要混用**：

| | `EXEMPTIONS` | `DIVERGENCES` |
|---|---|---|
| 意思 | 輸出幾乎一樣，差在無渲染影響的細節 | 我們決定不做那件事，**永遠**不會相符 |
| 做法 | 對 golden 套用轉換後再比 | 整頁略過，印出理由 |
| 記在 | [docs/08](../../../docs/08-verification.md) §7 | [docs/08](../../../docs/08-verification.md) §7b + [docs/09](../../../docs/09-known-issues.md) §4 |

流程：

1. 先判斷是哪一種 —— 「能做但很醜」不是豁免，是還沒做
2. 記進對應的文件小節，附原因與日期
3. 在 parity runner 加上對應設定
4. **不要**因此放寬 Level B 的 gating

Level A（byte）差異若判定接受，記進 [docs/08](../../../docs/08-verification.md) §7a 表格即可 —— 它本來就不 gating，不需要動 runner。
