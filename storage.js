/* Existing v1-v4 records are copied once into IndexedDB, with an atomic localStorage fallback. */
(function (root) {
  const KEY = "weight-checkin-records-v4";
  const OLD_KEYS = [KEY, "weight-checkin-records-v3", "weight-checkin-records-v2", "weight-checkin-records-v1"];
  const FALLBACK_KEY = "weight-checkin-state-v1";
  const DRAFT_PREFIX = "weight-checkin-draft-";
  let db;
  let fallback = false;
  let initialization;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function legacy() {
    for (const key of OLD_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        const records = JSON.parse(value);
        if (!Array.isArray(records)) throw new Error("旧记录格式异常，请先备份原始数据，避免覆盖。");
        return records;
      }
    }
    return [];
  }

  function fallbackState() {
    const saved = localStorage.getItem(FALLBACK_KEY);
    if (saved !== null) {
      const state = JSON.parse(saved);
      if (!state || !Array.isArray(state.records) || !state.drafts || typeof state.drafts !== "object" || Array.isArray(state.drafts)) {
        throw new Error("本机记录格式异常，请先备份原始数据，避免覆盖。");
      }
      return state;
    }
    const state = { records: legacy(), drafts: {} };
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(DRAFT_PREFIX)) {
        const date = key.slice(DRAFT_PREFIX.length);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) state.drafts[date] = JSON.parse(localStorage.getItem(key) || "null");
      }
    }
    return state;
  }

  function saveFallback(state) {
    // One setItem is atomic: quota/privacy errors keep the previous records and drafts intact.
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(state));
  }

  function validDraftDate(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("草稿日期无效。");
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("草稿日期无效。");
  }

  function cleanupLegacy() {
    OLD_KEYS.forEach((key) => localStorage.removeItem(key));
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
    }
  }

  function transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("data", mode);
      let request;
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = () => reject(tx.error || new Error("本机存储失败"));
      try {
        request = operation(tx.objectStore("data"));
      } catch (error) {
        try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
        reject(error);
      }
    });
  }
  function helpful(error) {
    if (error?.name === "QuotaExceededError") return new Error("本机存储空间不足，未能保存。请先导出备份，再删除不需要的照片。");
    return error instanceof Error ? error : new Error("本机存储不可用，请检查浏览器设置。");
  }
  root.CheckinStorage = {
    async init() {
      if (!initialization) {
        initialization = (async () => {
          fallback = !root.indexedDB;
          if (!root.indexedDB) fallback = true;
          else {
            try {
              db = await new Promise((resolve, reject) => {
                const request = root.indexedDB.open("weight-checkin-local-v1", 1);
                let settled = false;
                request.onupgradeneeded = () => request.result.createObjectStore("data");
                request.onsuccess = () => {
                  if (settled) request.result.close();
                  else { settled = true; resolve(request.result); }
                };
                request.onerror = () => { settled = true; reject(request.error); };
                request.onblocked = () => { settled = true; reject(new Error("请关闭其他旧版页面，再重新打开。")); };
              });
            } catch { fallback = true; }
          }
          if (!fallback && await transaction("readonly", store => store.get("records")) === undefined) {
            const state = fallbackState();
            await transaction("readwrite", (store) => {
              store.put(state.records, "records");
              Object.keys(state.drafts).forEach((date) => store.put(state.drafts[date], `draft-${date}`));
            });
          } else if (fallback) {
            // Fail visibly on corrupt/inaccessible legacy data; never silently replace it with [].
            fallbackState();
          }
          return { fallback };
        })().catch((error) => {
          initialization = undefined;
          throw helpful(error);
        });
      }
      return initialization;
    },
    async readRecords() {
      try { return fallback ? fallbackState().records : (await transaction("readonly", store => store.get("records"))) || []; }
      catch (error) { throw helpful(error); }
    },
    async writeRecords(records) {
      try {
        if (fallback) saveFallback({ ...fallbackState(), records });
        else await transaction("readwrite", store => store.put(records, "records"));
      } catch (error) { throw helpful(error); }
    },
    async readDraft(date) {
      try {
        validDraftDate(date);
        if (fallback) {
          const drafts = fallbackState().drafts;
          return own(drafts, date) ? drafts[date] : null;
        }
        return (await transaction("readonly", store => store.get(`draft-${date}`))) || null;
      } catch (error) { throw helpful(error); }
    },
    async writeDraft(date, entry) {
      try {
        validDraftDate(date);
        if (fallback) {
          const state = fallbackState();
          state.drafts[date] = entry;
          saveFallback(state);
        }
        else await transaction("readwrite", store => store.put(entry, `draft-${date}`));
      } catch (error) { throw helpful(error); }
    },
    async deleteDraft(date) {
      try {
        validDraftDate(date);
        if (fallback) {
          const state = fallbackState();
          delete state.drafts[date];
          saveFallback(state);
        } else await transaction("readwrite", store => store.delete(`draft-${date}`));
      } catch (error) { throw helpful(error); }
    },
    async clearAll() {
      try {
        if (fallback) {
          saveFallback({ records: [], drafts: {} });
          let legacyCleanupWarning = null;
          try { cleanupLegacy(); } catch {
            legacyCleanupWarning = "记录已清空，但浏览器阻止清理旧版本地备份。";
          }
          return { fallback, legacyCleanupWarning };
        }
        // The empty marker and draft deletion must commit together. Without this marker,
        // the next init() would mistake a cleared database for a new install and revive v1-v4.
        await transaction("readwrite", (store) => {
          store.clear();
          store.put([], "records");
        });
        let legacyCleanupWarning = null;
        try {
          // Prefer this envelope in fallback mode so old records/drafts cannot reappear.
          saveFallback({ records: [], drafts: {} });
          cleanupLegacy();
        } catch {
          legacyCleanupWarning = "当前记录已清空，但浏览器阻止清理旧版本地备份；若更换为兼容存储模式，请先检查旧版记录。";
        }
        return { fallback, legacyCleanupWarning };
      } catch (error) { throw helpful(error); }
    }
  };
})(window);
