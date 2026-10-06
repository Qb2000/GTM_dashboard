將 decoder 產生的 `*_tmtc_all.csv`、`*_tmtc_master.csv`、`*_tmtc_slave.csv` 放在此資料夾。

啟動 `npm start` 後會自動掃描；檔案大小及修改時間穩定至少 1.5 秒才載入。
建立持續監控面板時，使用 `GTM TMTC → MASTER／SLAVE · 全部 TMTC` 下的固定欄位。
新檔案會自動併入這些欄位，並更新已開啟的 Plot／Layout；不需為每個檔案重建 Plot。
歷史資料來自仍留在此資料夾中的檔案，請保留需要持續顯示的舊檔案。
同批有 `_all.csv` 時優先使用它，避免重複並修正 decoder 與 ICD 定義的差異。
不要放尚未完成的檔案：建議先以 `.partial` 副檔名複製，完成後再改為 `.csv`。

完整說明見 `docs/tmtc.md`，資料夾位置可在專案根目錄 `tmtc.config.json` 設定。
