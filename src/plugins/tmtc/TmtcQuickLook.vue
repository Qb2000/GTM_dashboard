<template>
  <div class="tmtc-quicklook">
    <h2>GTM TMTC 快速檢查</h2>
    <p>選擇 MASTER／SLAVE 的固定監控項目建立圖表；後續加入的 CSV 會自動併入同一個項目。</p>
    <p class="tmtc-path">監看資料夾：{{ catalog.inputDirectory || '連線中…' }}</p>
    <p v-if="error" role="alert" class="tmtc-warning">{{ error }}</p>
    <p v-for="message in catalog.errors" :key="message" class="tmtc-warning">{{ message }}</p>
    <p v-if="!catalog.datasets.length">
      尚無可用資料。請將 *_tmtc_all.csv 或 master/slave CSV 放入上述資料夾。
    </p>
    <label class="tmtc-control">
      監控來源 / Module
      <select v-model="selectedId" aria-label="TMTC dataset">
        <option v-for="item in datasets" :key="item.id" :value="item.id">
          {{ item.batch }} / {{ item.module.toUpperCase() }} ({{ item.count }} packets)
        </option>
      </select>
    </label>
    <template v-if="dataset">
      <p v-if="dataset.scope === 'monitor'">
        固定監控來源 · {{ dataset.sourceCount }} 份來源檔。可將欄位加入
        Plot／Layout，新增檔案後自動更新並延伸範圍。
      </p>
      <div class="tmtc-summary">
        <span
          >{{ dataset.count }} packets · {{ dataset.fields.length }} channels ·
          {{ dataset.distinctUTC }} 個不同的有效 ICD UTC</span
        >
        <span>UTC：{{ utc(dataset.bounds.utc?.start) }} → {{ utc(dataset.bounds.utc?.end) }}</span>
        <span>Counter：{{ dataset.bounds.packet?.start }} → {{ dataset.bounds.packet?.end }}</span>
        <span
          >無效 UTC {{ dataset.invalidUTC }} · 拒收列 {{ dataset.rejectedRows }} · Checksum 異常
          {{
            dataset.checksumFailures === null ? '未檢查（無原始 bytes）' : dataset.checksumFailures
          }}</span
        >
        <span
          >檔案內 Counter 回捲 / 倒序 {{ dataset.counterBacktracks }} · 相鄰重複
          {{ dataset.repeatedCounters }}</span
        >
      </div>
      <details class="tmtc-notes">
        <summary>來源與判讀注意事項</summary>
        <p>來源：{{ dataset.source }}；定義：ICD CDRL-1009 rev L, Table 5-4。</p>
        <p v-for="warning in dataset.warnings" :key="warning">{{ warning }}</p>
        <p>
          UTC 預設為整秒，Subsecond 原值保留為独立欄位。raw / tick
          欄位沒有套用未經確認的溫度或電壓校正。
        </p>
        <p>
          Packet Counter 使用封包原值；跨檔重置或回捲後可能有相同 x 值，新檔案不保證出現在右側。UTC
          圖依封包時間放置資料。異常 checksum 封包仍保留供檢查。
        </p>
      </details>
      <label class="tmtc-control"
        >搜尋欄位
        <input
          v-model="filter"
          type="search"
          placeholder="Temperature、Hit Counter、HV、SEE…"
          aria-label="Filter TMTC fields"
      /></label>
      <table class="tmtc-fields">
        <thead>
          <tr>
            <th>項目</th>
            <th>分類 / Bytes</th>
            <th>單位</th>
            <th>最小 / 最大</th>
            <th>最後值</th>
            <th>開啟圖表</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in fields" :key="field.key">
            <td :title="field.description">{{ field.name }}</td>
            <td>{{ field.group }} · {{ field.bytes || 'derived' }}</td>
            <td>{{ field.unit }}</td>
            <td>{{ number(field.start) }} / {{ number(field.end) }}</td>
            <td>{{ number(field.last) }}</td>
            <td class="tmtc-buttons">
              <button
                type="button"
                :disabled="!dataset.bounds.utc"
                :aria-label="`Plot ${field.name} by UTC`"
                @click="plot(field, 'utc')"
              >
                UTC</button
              ><button
                type="button"
                :aria-label="`Plot ${field.name} by Packet Counter`"
                :disabled="!dataset.bounds.packet"
                @click="plot(field, 'packet')"
              >
                Packet Counter
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
    <details class="tmtc-notes">
      <summary>匯入狀態 ({{ catalog.files.length }} files)</summary>
      <p v-for="file in catalog.files" :key="file.name">
        {{ file.name }} — {{ file.status }} {{ file.message }}
      </p>
    </details>
  </div>
</template>
<script>
import { fitDataset, NAMESPACE } from './TMTCClient.js';
export default {
  inject: ['openmct', 'domainObject', 'tmtcClient'],
  data() {
    return {
      catalog: this.tmtcClient.catalog,
      error: this.tmtcClient.error,
      selectedId: '',
      filter: ''
    };
  },
  computed: {
    datasets() {
      return this.tmtcClient.datasets(this.catalog);
    },
    dataset() {
      return this.datasets.find((d) => d.id === this.selectedId);
    },
    fields() {
      return (this.dataset?.fields || []).filter((f) =>
        `${f.name} ${f.group}`.toLowerCase().includes(this.filter.toLowerCase())
      );
    }
  },
  mounted() {
    this.update(this.tmtcClient.catalog);
    this.unsubscribe = this.tmtcClient.onChange(this.update);
  },
  beforeUnmount() {
    this.unsubscribe();
  },
  methods: {
    update(catalog) {
      this.catalog = catalog;
      this.error = this.tmtcClient.error;
      const datasets = this.tmtcClient.datasets(catalog);
      if (!datasets.some((d) => d.id === this.selectedId)) {
        this.selectedId =
          datasets.find((d) => d.id === this.domainObject.tmtc?.dataset)?.id ||
          (this.domainObject.identifier.key === 'files'
            ? catalog.datasets[0]?.id
            : datasets[0]?.id) ||
          '';
      }
      const [, , group] = this.domainObject.identifier.key.split(':');
      if (group !== undefined && !this.filter && this.dataset) {
        this.filter = this.tmtcClient.groups(this.dataset)[Number(group)] || '';
      }
    },
    utc(value) {
      return value === null || value === undefined
        ? '無效 / 未提供'
        : new Date(value).toISOString();
    },
    number(value) {
      return value === null || value === undefined ? '—' : Number(value.toPrecision(8)).toString();
    },
    plot(field, axis) {
      if (!fitDataset(this.openmct, this.dataset, axis)) {
        return;
      }
      const group = this.tmtcClient.groups(this.dataset).indexOf(field.group);
      const keys = [
        'root',
        ...(this.dataset.scope === 'monitor' ? [] : ['files']),
        `d:${this.dataset.id}`,
        `g:${this.dataset.id}:${group}`,
        `f:${this.dataset.id}:${field.key}`
      ];
      const route = keys.map((key) => `${NAMESPACE}:${key}`).join('/');
      this.openmct.router.navigate(`#/browse/${route}?view=plot-single`);
    }
  }
};
</script>
<style scoped>
.tmtc-quicklook {
  overflow: auto;
  height: 100%;
  padding: 18px 24px;
}
.tmtc-quicklook h2 {
  margin: 0 0 12px;
}
.tmtc-path {
  overflow-wrap: anywhere;
  opacity: 0.8;
}
.tmtc-warning {
  color: #ffca76;
}
.tmtc-control {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}
.tmtc-control select,
.tmtc-control input {
  min-width: 340px;
  max-width: 85%;
  padding: 5px;
}
.tmtc-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: #7772;
}
.tmtc-notes {
  margin: 14px 0;
}
.tmtc-notes summary {
  cursor: pointer;
}
.tmtc-fields {
  width: 100%;
  border-collapse: collapse;
}
.tmtc-fields th,
.tmtc-fields td {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid #7775;
}
.tmtc-fields th {
  position: sticky;
  top: 0;
  background: #252b30;
  color: #fff;
}
.tmtc-fields tr:hover {
  background: #7772;
}
.tmtc-buttons {
  white-space: nowrap;
}
.tmtc-buttons button {
  margin-right: 6px;
  padding: 5px 9px;
  border: 1px solid #7a9eae;
  border-radius: 3px;
  background: #233e4c;
  color: #f3f8fa;
  cursor: pointer;
}
.tmtc-buttons button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
