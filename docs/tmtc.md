# GTM TMTC 自動匯入與快速檢查

## 使用方式

1. 在 Open MCT 專案執行 `npm start`，開啟終端機顯示的本機網址（預設 `http://localhost:8080`）。如果已有舊的開發服務，修改後需重新啟動一次。
2. 將 decoder 輸出放到 `data/tmtc-inbox`。目前已放入使用者提供的 `FS8B_SPL_2026232023029_145` 三份 CSV 作為本機範例；資料檔不會加入 Git。
3. 點左側 **GTM TMTC → MASTER · 全部 TMTC** 或 **SLAVE · 全部 TMTC**。這兩個固定來源合併 inbox 內所有批次，後續新增檔案會自動加入。
4. 搜尋任何欄位，點 **UTC** 或 **Packet Counter**，即開啟該欄位的 Open MCT 原生 Plot，並套用該批資料的完整範圍。
5. 在圖表上方 **More actions** 可選 **TMTC: Plot by UTC / Fit range** 或 **TMTC: Plot by Packet Counter / Fit range**，同步切換查詢的時間系統並適配範圍。已儲存且包含 TMTC 欄位的 Overlay Plot 也有這兩個動作；放在 Layout 中時使用該 Plot 框架的選單。單獨切換原生 x 軸選單只改圖表顯示，全域時間系統仍須與查詢軸配合，監控請使用上述動作。
6. 展開固定來源的分類，將所需欄位拖入自行建立的 Overlay Plot／Stacked Plot，再加入 Layout 並儲存。每個欄位只需建立一次面板，新增檔案時已開啟的圖也會更新。以 UTC 為 x 軸、Packet Counter 欄位為 y 軸也同樣支援。
7. **個別檔案（診斷用）** 保留原本的批次來源。以前連到個別檔案的 Plot 仍保留原行為；若要持續監控，在 Plot 編輯模式將資料序列換成 MASTER／SLAVE 固定來源下的同一欄位一次即可，之後不需逐檔新增。此更新不自動改寫已儲存的 Layout。

固定來源識別碼為 `gtm-tmtc:f:all-master:<field>`／`gtm-tmtc:f:all-slave:<field>`，不含檔名；即使資料夾暫時清空或服務重啟，欄位仍可解析。MASTER／SLAVE 分開，避免相同欄位名稱混合兩個 module。

回到原有 Layout 等非 TMTC 頁面時，會恢復進入 TMTC 前的全域時間設定。原有圖表仍存在原來瀏覽器／網址的 localStorage；Chrome 的 `http://localhost:8080` 與 Codex 內建瀏覽器的 `http://127.0.0.1:8080` 不共用此資料。此功能不修改既有 Layout 或衛星地圖物件。

服務每 2 秒檢查一次資料夾，瀏覽器每 3 秒更新目錄。檔案大小及修改時間至少穩定 1.5 秒才匯入；一般約 2–7 秒內出現。不必手動轉 JSON 或重新整理網頁。新檔案、替換和刪除會更新目錄及已開啟的單項／Overlay／Stacked／Layout 中對應的 Plot。固定時間模式下，監控圖的全域或獨立時間範圍會擴大以包含合併資料；不縮小目前範圍。編輯 Plot／Layout 時延後重載，結束編輯後更新。Realtime 模式保持使用者設定的滑動視窗。

累積資料以 inbox 內仍存在的檔案為準：要保留歷史資料就保留舊檔；刪檔後該檔獨有的點會從合併來源移除。完整內容相同的同格式檔案副本只計一次；不同檔案部分重疊的封包不會武斷去重，避免把合法的重複封包／重置資料刪掉。API 每筆點保留來源檔名與行號。

建議先複製為 `.partial`，完成後才改名為 `.csv`。檔案暫停寫入也可能看起來穩定，因此輪詢不能代替生產端的原子改名。只掃描 inbox 第一層，支援檔名 `*_tmtc_all.csv`、`*_tmtc_master.csv`、`*_tmtc_slave.csv`；其他檔案不匯入。

## 資料來源與定義

- 依據 `ICD CDRL-1009 NSPO 240926_L.pdf`（rev L, 2024-09-26），Table 5-4，文件印刷頁 23–28（PDF 頁 24–29）。
- 參照 `GTM_SDC-main/gtm_gui/GTM_Decoder_Function.c` 的欄位命名、符號位及 CSV 格式。
- 同批有 `_all.csv` 時，以其中 128-byte 封包與可選的 16-byte 前置資料為準；同名 master/slave 為 companion，不重複匯入。同批判斷依 `_tmtc_*` 前的完整檔名。
- 只有 master/slave CSV 也可讀取。分號分隔、BOM、CRLF、空白與同名 SEE 欄位都有處理。
- 固定監控來源按 module 合併所有檔案，原批次來源另保留供診斷。每個數值欄位均提供 `utc`、`packet` 兩個 domain，並保留 CSV 行號。
- Master / Slave 各 114 個原始欄位與工程換算欄分開。含 GICD 的 `_all.csv` 匯入後為 Master 127、Slave 129 項。
- SEE 的重名欄位分成 bit8-0 與 bit17-9，對應 bytes 114/115、116/117。
- `Engineering` 分類包含 live time 秒数／百分比、電流 A、電壓 V、monitor 溫度、SPW error bit 欄位、counter period ms。名稱及描述列出換算依據。
- Board / CITIROC Temperature 保留 decoder 數值並標為 `raw`；未取得足夠校正依據，不將其直接宣稱為攝氏。電流監測晶片的符號解讀沿用 decoder 的 signed int8，乘 ICD 的 0.48 °C/LSB。

## 時間、counter 與品質

UTC = 封包 ICD Year + 一起算的 ICD Day（年積日）+ Hour/Minute/Second，以 UTC 建立 Unix epoch milliseconds。**不使用檔名、檔案時間或電腦當地時區，也不將 GICD 接收時間混入 ICD 時間。** GICD 各分量仍可當作遙測項目檢查。

ICD 表格只列出 Subsecond byte，未明確指定時間單位。預設不將其加到 x 軸，原值仍保留；確認單位後，可設定 `subsecondMilliseconds` 為每一計數的毫秒數（例如只有確定為 1/256 秒時，才設為 `3.90625`）。legacy decoded-only CSV 的 Subsecond 有已知輸出錯誤，因此無論此設定為何都使用整秒。

UTC 不合法的封包只從 UTC 查詢排除，仍可在 counter 圖中檢查；不補造時間。重複時間不去重、不插值。如果封包內時間僅在收到 CMD-UTC 時更新，UTC 圖會在相同 x 值出現多筆資料；本功能忠實使用欄位值，未利用 PPS 重建時間。

Packet Counter 使用原始 16-bit 數字，不等同資料行號，也不展開回捲。查詢按原值排序，同一來源的相同值保留行順序；跨檔同值以 UTC／來源排序。跨回捲／重置可能有重疊 x 值和跨週期連線，新增檔案不保證畫在右側。摘要的倒序／相鄰重複數為各檔案內的統計。若希望依時間觀察累積資料，請使用 UTC 軸；不會用檔名或匯入順序假造時間或 counter。

完整原始封包會檢查 header/tail、GTM ID、byte 範圍及 checksum（bytes 2–124 的和 mod 256）。checksum 失敗資料保留並計數。結構錯誤的列拒收並显示數量和最後錯誤行；缺失的解碼欄位為 null，不冒充零。decoded-only 無法完整檢驗 checksum，顯示「未檢查」。錯誤檔案若已有有效快照，保留上一版並在狀態中明確標示錯誤。

## 目前 decoder 的相容處理

`decodedCsvProfile` 預設為 `gtm-gui-legacy`，對應本次檢查的 decoder：

1. `ICD Subsecond` 實際寫入 `icd_second`：不能從 master/slave CSV 恢復，UTC 使用整秒；`_all.csv` 可以取得真正 byte 14。
2. Slave 的 Input / HV Current 與 Voltage 欄位名稱順序和 `fprintf` 順序相反：匯入時交換。
3. Slave 的 HV byte 109：ICD rev L 指定 high nibble 為 voltage、low nibble 為 current，而 decoder 組合相反：匯入時重組 low nibbles。
4. decoded-only Slave 額外提供四項 **CSV originals**，保留改正前的原始數值。

`_all.csv` 直接使用 ICD 定義，不依賴上述修補。未修改外部 decoder 原始碼。未來 decoder 修正後，請將 `decodedCsvProfile` 設為 `icd`，避免重複更正；不要混用兩種版本的 decoded-only CSV。

## 設定與架構

修改專案根目錄 `tmtc.config.json` 後重新啟動 `npm start`：

```json
{
  "inputDirectory": "data/tmtc-inbox",
  "pollMilliseconds": 2000,
  "settleMilliseconds": 1500,
  "subsecondMilliseconds": null,
  "decodedCsvProfile": "gtm-gui-legacy"
}
```

`inputDirectory` 可為絕對路徑或相對專案根目錄的路徑。環境變數 `TMTC_INPUT_DIR` 優先於設定檔。瀏覽器不能直接監看 Windows 資料夾，因此由 Node 開發服務讀取 CSV，透過同源唯讀 API 供應 Open MCT telemetry provider。

- `GET /api/tmtc/catalog`：`monitors` 是固定的 MASTER／SLAVE 合併來源；`datasets` 是各檔案來源，另有檔案狀態、欄位定義、品質與範圍。
- `GET /api/tmtc/series?id=all-master&field=b20&domain=utc&start=...&end=...`：合併數值列 `{ utc, packet, value, row, source }`。Slave 改用 `all-slave`，counter 查詢改為 `domain=packet`。原批次 id 查詢保持可用。
- 不產生或要求使用者管理第二套 JSON 檔；轉換結果保存在服務記憶體，重啟會重建。
- 此整合安裝於 `npm start` 的 webpack development server。僅部署 `dist` 靜態檔或使用 `start:prod` 不會提供 inbox API；正式部署需在 Node 主機安裝 `createTMTCService` middleware 或反向代理 API。
- 為保留快速檢查的尖峰，API 回傳範圍內所有資料，沒有抽樣。適合目前批次規模；大量長期資料需另接資料庫／索引。
- 新檔更新只重載受影響的 Plot，不重建所在 Layout 或修改已存的圖表配置。只掃描目前開啟的 Plot／Layout 組合，不重載其他未開啟的圖。Table 可查詢合併來源，但目前自動重載的驗證範圍是 Plot。

## 驗證

`npm run test:tmtc` 測試 ICD byte mapping、負值、HV nibble、工程換算、UTC/年積日/閏年、無效時間保留、counter 回捲／重複、CSV 相容修補、重名欄位、檔案穩定等待／替換／刪除、API domain 查詢及 Open MCT metadata。

另測試固定監控識別碼、較晚檔案加入、同檔副本去重、重啟／清空資料夾、MASTER／SLAVE 分流及 Layout 內已儲存 Plot 的更新與獨立範圍。瀏覽器以隔離的合成測試資料驗證同一個已儲存 Layout 的 UTC 與 Packet Counter Plot 在加入新檔案後自動更新，沒有重新整理頁面；正式 inbox 未加入合成資料。

範例批次 Master / Slave 各 5,113 筆；無效 ICD UTC 分別 3 / 4 筆，原始封包 checksum 失敗 0 筆，各只有 2 個有效 ICD UTC 值。全批次比對 raw 與修正後 decoded CSV，除已知 ICD Subsecond 輸出差異外，1,298,702 個數值一致。
