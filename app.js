(function () {
  'use strict';
  const Core = window.CheckinCore, Store = window.CheckinStorage;
  const $ = id => document.getElementById(id);
  const MEALS = [['breakfast', '早餐', 'BREAKFAST'], ['lunch', '午餐', 'LUNCH'], ['dinner', '晚餐', 'DINNER'], ['snacks', '加餐', 'SNACKS']];
  const FIELDS = ['weight', 'targetWeight', 'water', 'exercise', 'mood', 'notes'];
  const API = '/.netlify/functions/recognize-meal';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const present = value => value !== '' && value !== null && value !== undefined;
  const validDate = date => { try { Core.validateRecords([{ date }]); return true; } catch { return false; } };
  const sort = items => [...items].sort((a, b) => b.date.localeCompare(a.date));
  const safePhoto = value => typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
  let records = [], entry = {}, date = Core.todayISO(), ready = false, dirty = false, loading = false, saving = false;
  let queue = Promise.resolve(), session = 0, epoch = 0, revision = 0, draftedRevision = 0;
  let draftTimer, toastTimer, undo = null, token = '', installPrompt = null;
  let service = { checked: false, configured: false, reason: '正在检查识别服务…' };
  const draftVersions = new Map(), draftCalories = new Map(), photoVersions = new Map(), calorieVersions = new Map(), jobs = new Map(), requests = new Map(), ui = new Map();

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function on(target, name, action) {
    target.addEventListener(name, async event => { try { await action(event); } catch (error) { showError(error); } });
  }
  function button(text, className, action) {
    const result = element('button', className, text); result.type = 'button';
    if (action) on(result, 'click', action);
    return result;
  }
  function enqueue(action) { const next = queue.then(action); queue = next.catch(() => {}); return next; }
  function toast(text, action = null) {
    clearTimeout(toastTimer); $('toastText').textContent = text; undo = action; $('undoAction').hidden = !action; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; undo = null; }, action ? 30000 : 6500);
  }
  function status(text, changed = dirty) { $('saveStatus').textContent = text; $('saveStatus').classList.toggle('dirty', changed); }
  function showError(error) {
    toast(error?.message || '操作未完成，请重试。');
    if (dirty) status('修改未保存，请重试', true);
  }
  function controls() {
    const locked = !ready || loading || saving;
    $('entryForm').querySelectorAll('input,textarea,select,button').forEach(item => { item.disabled = locked; });
    $('saveEntry').disabled = locked || jobs.size > 0 || !validDate($('date').value);
    $('saveEntry').textContent = saving ? '保存中…' : jobs.size ? '照片处理中…' : '保存打卡 ✓';
    $('clearAll').disabled = !ready || saving; $('importData').disabled = !ready || saving;
    if ($('importTrigger')) $('importTrigger').disabled = !ready || saving;
    for (const [meal, card] of ui) {
      card.remove.disabled = locked || !entry.mealPhotos?.[meal];
      card.analyze.disabled = locked || jobs.has(meal) || !entry.mealPhotos?.[meal] || requests.has(meal);
    }
  }
  function capture() {
    const result = clone(entry); result.date = date;
    FIELDS.forEach(field => { result[field] = $(field).value.trim(); });
    return Core.normalizeEntry(result);
  }
  function totals() {
    const today = Core.todayISO(), todayEntry = date === today && $('date').value === today ? entry : draftCalories.has(today) ? { calories: draftCalories.get(today) } : records.find(item => item.date === today);
    $('calorieStatus').textContent = `${Core.sumCalories(entry)} kcal${!entry.mealCalories && present(entry.legacyCalories) ? ' · 旧版总热量' : ''}`;
    $('todayCalories').textContent = `${Core.sumCalories(todayEntry)} kcal`;
    // A previous offline shell can briefly load a newer script during an update.
    if (typeof Core.calorieBudget !== 'function' || !['entryBudgetSummary', 'todayBudget', 'dailyCalorieGoal', 'todayBudgetLabel', 'todayRemaining', 'calorieProgress'].every(id => $(id))) {
      if ($('todayBudget')) $('todayBudget').hidden = true;
      if ($('entryBudgetSummary')) $('entryBudgetSummary').hidden = true;
      return;
    }
    const current = Core.calorieBudget(entry);
    $('entryBudgetSummary').textContent = `目标 ${current.goal} kcal · ${current.over > 0 ? `已超出 ${current.over}` : `还剩 ${current.remaining}`} kcal`;
    $('entryBudgetSummary').classList.toggle('over-budget', current.over > 0);
    const budget = Core.calorieBudget(todayEntry);
    $('dailyCalorieGoal').textContent = `${budget.goal} kcal`;
    $('todayBudgetLabel').textContent = budget.over > 0 ? '今日已超出' : '今日还剩';
    $('todayRemaining').textContent = `${budget.over > 0 ? budget.over : budget.remaining} kcal`;
    $('todayBudget').classList.toggle('over-budget', budget.over > 0);
    $('calorieProgress').max = budget.goal; $('calorieProgress').value = Math.min(budget.consumed, budget.goal);
    $('calorieProgress').setAttribute('aria-label', `今日已记录 ${budget.consumed} 大卡，目标 ${budget.goal} 大卡，${budget.over > 0 ? `已超出 ${budget.over}` : `还剩 ${budget.remaining}`} 大卡`);
  }
  function draftNow() {
    clearTimeout(draftTimer);
    if (!ready || !dirty || !validDate(date) || $('date').value !== date) return Promise.resolve();
    const snapshot = capture(), targetDate = date, version = draftVersions.get(date), currentEpoch = epoch, currentRevision = revision, currentSession = session;
    return enqueue(async () => {
      if (currentEpoch !== epoch || version !== draftVersions.get(targetDate)) return;
      await Store.writeDraft(targetDate, snapshot);
      draftCalories.set(targetDate, Core.sumCalories(snapshot));
      if (targetDate === date && currentSession === session && revision === currentRevision) { draftedRevision = currentRevision; status('草稿已存本机 · 待保存打卡'); }
    });
  }
  function changed() {
    if (!ready || loading || saving) return;
    dirty = true; revision += 1; draftVersions.set(date, (draftVersions.get(date) || 0) + 1);
    status('正在保存本机草稿…'); totals(); clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftNow().catch(showError); }, 500);
  }
  function cancel(meal) { const work = requests.get(meal); if (work) { work.controller.abort(); requests.delete(meal); } if (ui.has(meal)) ui.get(meal).analyze.textContent = 'AI 估算'; }
  function cancelAll() { MEALS.forEach(([meal]) => { cancel(meal); photoVersions.set(meal, (photoVersions.get(meal) || 0) + 1); }); jobs.clear(); }
  function clearPhoto(target, meal) {
    if (target.mealPhotos) delete target.mealPhotos[meal];
    if (target.mealAnalyses) delete target.mealAnalyses[meal];
    if (target.mealCalorieSources?.[meal] === 'ai') { if (target.mealCalories) delete target.mealCalories[meal]; delete target.mealCalorieSources[meal]; }
  }
  function snapshotMeal(target, meal) { return Object.fromEntries(['mealPhotos', 'mealCalories', 'mealAnalyses', 'mealCalorieSources'].map(key => [key, clone(target[key]?.[meal])])); }
  function restoreMeal(target, meal, saved) {
    const manual = target.mealCalorieSources?.[meal] === 'manual' ? target.mealCalories?.[meal] : undefined;
    Object.entries(saved).forEach(([key, value]) => { if (value === undefined) { if (target[key]) delete target[key][meal]; } else { target[key] ||= {}; target[key][meal] = clone(value); } });
    if (manual !== undefined) { target.mealCalories ||= {}; target.mealCalorieSources ||= {}; target.mealCalories[meal] = manual; target.mealCalorieSources[meal] = 'manual'; }
  }
  function showPhoto(photo, label) { if (safePhoto(photo)) { $('largePhoto').src = photo; $('largePhoto').alt = label; $('photoDialog').showModal(); } }
  function calorieMode() {
    if (!entry.mealCalories) {
      const old = Core.sumCalories(entry); entry.mealCalories = {}; delete entry.legacyCalories;
      if (old) toast(`已切换为分餐记录，原总热量 ${old} kcal 请分配到各餐。`);
    }
    entry.mealCalorieSources ||= {};
  }
  function mealStatus(meal, text, error = false) { const target = ui.get(meal).status; target.textContent = text; target.classList.toggle('error', error); }
  function describe(analysis) {
    if (!analysis) return '可手填热量，或使用 AI 照片估算';
    return `${analysis.range ? `估算 ${analysis.range.min}–${analysis.range.max} kcal · ` : ''}置信度${{ low: '较低', medium: '中等', high: '较高' }[analysis.confidence] || '待核对'}，请核对份量`;
  }
  function renderFoods(meal) {
    const card = ui.get(meal), analysis = entry.mealAnalyses?.[meal]; card.foods.replaceChildren(); card.details.hidden = !analysis?.foods?.length;
    if (!analysis?.foods?.length) return;
    card.summary.textContent = `食物明细 · ${analysis.totalKcal ?? entry.mealCalories?.[meal] ?? 0} kcal`;
    const head = element('div', 'food-row food-head'); ['食物', '克数', 'kcal'].forEach(text => head.append(element('span', '', text))); card.foods.append(head);
    analysis.foods.forEach((food, index) => {
      const row = element('div', 'food-row');
      ['name', 'grams', 'kcal'].forEach(field => {
        const input = document.createElement('input'); input.type = field === 'name' ? 'text' : 'number'; input.value = food[field] ?? '';
        input.setAttribute('aria-label', `${MEALS.find(item => item[0] === meal)[1]}第 ${index + 1} 项${{ name: '食物', grams: '克数', kcal: '千卡' }[field]}`);
        if (field === 'name') input.maxLength = 120; else { input.min = '0'; input.max = field === 'grams' ? '20000' : '10000'; input.step = '0.1'; }
        on(input, 'input', () => {
          cancel(meal); calorieVersions.set(meal, (calorieVersions.get(meal) || 0) + 1);
          const grams = Number(food.grams), kcal = Number(food.kcal); food[field] = input.value;
          if (field === 'grams' && present(input.value) && grams > 0 && Number(input.value) >= 0 && Number.isFinite(kcal)) { food.kcal = Math.round(kcal * Number(input.value) / grams); row.querySelectorAll('input')[2].value = food.kcal; }
          const total = Math.round(analysis.foods.reduce((sum, item) => sum + (Number(item.kcal) || 0), 0)); analysis.totalKcal = total; delete analysis.range;
          if (!analysis.notes?.includes('已手动调整')) analysis.notes = `${analysis.notes || ''} 已手动调整明细，原估算范围不再适用。`.trim();
          calorieMode(); entry.mealCalories[meal] = total; entry.mealCalorieSources[meal] = 'manual'; card.calories.value = total;
          card.summary.textContent = `食物明细 · ${total} kcal（已调整）`; card.note.textContent = analysis.notes;
          mealStatus(meal, '已手动调整，请核对各项份量和热量'); changed(); controls();
        }); row.append(input);
      }); card.foods.append(row);
    }); card.note.textContent = analysis.notes || '照片热量为估算，请核对份量和用油。';
  }
  function renderMeal(meal) {
    const card = ui.get(meal), photo = entry.mealPhotos?.[meal]; card.preview.classList.toggle('has-photo', safePhoto(photo));
    if (safePhoto(photo)) card.image.src = photo; else card.image.removeAttribute('src');
    card.calories.value = entry.mealCalories?.[meal] ?? ''; card.hint.value = entry.mealHints?.[meal] || '';
    mealStatus(meal, describe(entry.mealAnalyses?.[meal])); renderFoods(meal);
  }
  function renderEntry(value, draft = false) {
    entry = Core.normalizeEntry(clone(value)); entry.date = date; entry.mealPhotos ||= {};
    FIELDS.forEach(field => { $(field).value = entry[field] ?? (field === 'mood' ? '平稳' : ''); });
    if (!$('mood').value) { if (entry.mood) $('mood').append(element('option', '', entry.mood)); $('mood').value = entry.mood || '平稳'; }
    $('date').value = date; $('formTitle').textContent = date === Core.todayISO() ? '今日打卡' : `${date} 打卡`;
    $('calorieDateLabel').textContent = `${date === Core.todayISO() ? '今日' : date}已记录热量`;
    MEALS.forEach(([meal]) => { renderMeal(meal); ui.get(meal).photo.value = ''; ui.get(meal).camera.value = ''; });
    dirty = draft; revision += 1; draftedRevision = revision;
    status(draft ? '已恢复本机草稿 · 待保存打卡' : records.some(item => item.date === date) ? '已保存于本机' : '尚未保存'); totals(); controls();
  }
  async function loadDate(nextDate) {
    if (!validDate(nextDate)) throw new Error('请选择有效日期。');
    if (dirty && $('date').value !== date) throw new Error('当前日期为空，请先重新选择日期以保留这份草稿。');
    await draftNow(); const version = ++session; cancelAll(); date = nextDate; loading = true; controls();
    try {
      const draft = await enqueue(() => Store.readDraft(nextDate)); if (version !== session) return;
      if (draft && (typeof draft !== 'object' || Array.isArray(draft) || draft.date !== nextDate)) throw new Error('该日期草稿格式异常，请先导出已保存记录。');
      if (draft) draftCalories.set(nextDate, Core.sumCalories(draft)); else draftCalories.delete(nextDate);
      renderEntry(draft || records.find(item => item.date === nextDate) || { date: nextDate, mealPhotos: {}, mealCalories: {} }, Boolean(draft));
    } finally { if (version === session) { loading = false; controls(); } }
  }
  async function mutate(action) {
    if (!ready) throw new Error('本机存储不可用，无法修改记录。');
    const operationEpoch = epoch;
    return enqueue(async () => {
      if (operationEpoch !== epoch) throw new Error('记录状态已改变，请重新操作。');
      const latest = Core.validateRecords(await Store.readRecords()), next = sort(Core.validateRecords(action(clone(latest))));
      await Store.writeRecords(next); records = next; refresh();
    });
  }
  async function save(event) {
    event.preventDefault(); if (!ready || saving) return;
    if (jobs.size) throw new Error('照片还在处理中，请等预览出现后保存。');
    if (!validDate($('date').value) || $('date').value !== date) throw new Error('请先选择有效日期，等待该日记录载入后再保存。');
    if (date > Core.todayISO()) throw new Error('未来日期仅供查看，不能提前保存打卡。请选择今天或过去的日期。');
    if (!$('entryForm').reportValidity()) return;
    const value = Core.validateRecords([{ ...capture(), updatedAt: new Date().toISOString() }])[0], targetDate = date, version = session;
    MEALS.forEach(([meal]) => cancel(meal)); clearTimeout(draftTimer); draftVersions.set(date, (draftVersions.get(date) || 0) + 1); saving = true; controls(); status('正在保存…');
    try {
      await mutate(items => [...items.filter(item => item.date !== targetDate), value]);
      try { await enqueue(() => Store.deleteDraft(targetDate)); draftCalories.delete(targetDate); }
      catch (error) { status('记录已保存，旧草稿未清理', true); toast(`记录已保存，但旧草稿未清理：${error.message}`); return; }
      if (version === session) { renderEntry(value); dirty = false; status('已保存于本机', false); }
      toast('打卡已保存到本机，照片和热量已更新。');
    } catch (error) { status('保存失败，修改仍在页面中', true); throw error; }
    finally { saving = false; controls(); }
  }
  async function removeCurrent(meal) {
    if (!entry.mealPhotos?.[meal]) return;
    const saved = snapshotMeal(entry, meal), targetDate = date, version = session, operationEpoch = epoch;
    cancel(meal); photoVersions.set(meal, (photoVersions.get(meal) || 0) + 1); jobs.delete(meal); clearPhoto(entry, meal); renderMeal(meal); changed(); controls(); await draftNow();
    if (operationEpoch !== epoch) return;
    toast('已从草稿移除照片，保存打卡后生效。', async () => {
      if (date !== targetDate || version !== session || entry.mealPhotos?.[meal]) throw new Error('日期或照片已改变，未覆盖现有内容。');
      restoreMeal(entry, meal, saved); renderMeal(meal); changed(); controls(); await draftNow(); toast('照片已恢复到草稿，请保存打卡。');
    });
  }
  async function removeHistoryPhoto(targetDate, meal) {
    const original = records.find(item => item.date === targetDate); if (!original?.mealPhotos?.[meal]) return;
    const saved = snapshotMeal(original, meal), photo = original.mealPhotos[meal], operationEpoch = epoch;
    await mutate(items => items.map(item => { if (item.date === targetDate && item.mealPhotos?.[meal] === photo) clearPhoto(item, meal); return item; }));
    if (operationEpoch !== epoch) return;
    // A saved photo must also disappear from an older draft, or editing that date could revive it.
    await enqueue(async () => {
      if (operationEpoch !== epoch) return;
      const draft = await Store.readDraft(targetDate);
      if (draft?.mealPhotos?.[meal] === photo) { clearPhoto(draft, meal); await Store.writeDraft(targetDate, draft); draftCalories.set(targetDate, Core.sumCalories(draft)); }
    });
    if (operationEpoch !== epoch) return;
    totals();
    if (date === targetDate && entry.mealPhotos?.[meal] === photo) {
      cancel(meal); photoVersions.set(meal, (photoVersions.get(meal) || 0) + 1); clearPhoto(entry, meal); renderMeal(meal);
      if (dirty) { changed(); await draftNow(); } else totals(); controls();
    }
    toast('历史照片已删除，其他内容已保留。', async () => {
      await mutate(items => {
        const target = items.find(item => item.date === targetDate); if (!target) throw new Error('该日记录已删除，无法单独恢复照片。');
        if (target.mealPhotos?.[meal]) throw new Error('这餐已有新照片，未覆盖现有内容。'); restoreMeal(target, meal, saved); return items;
      });
      await enqueue(async () => { const draft = await Store.readDraft(targetDate); if (draft && !draft.mealPhotos?.[meal]) { restoreMeal(draft, meal, saved); await Store.writeDraft(targetDate, draft); draftCalories.set(targetDate, Core.sumCalories(draft)); } });
      if (date === targetDate && !entry.mealPhotos?.[meal]) { restoreMeal(entry, meal, saved); renderMeal(meal); if (dirty) { changed(); await draftNow(); } else totals(); controls(); }
      totals(); toast('历史照片已恢复。');
    });
  }
  async function removeDay(targetDate) {
    if (!confirm(`删除 ${targetDate} 的整天记录及该天草稿吗？删除后可在提示中撤销。`)) return;
    const original = clone(records.find(item => item.date === targetDate)), operationEpoch = epoch; if (!original) return;
    if (targetDate === date) await draftNow();
    const oldDraft = await enqueue(() => Store.readDraft(targetDate)); draftVersions.set(targetDate, (draftVersions.get(targetDate) || 0) + 1);
    await mutate(items => items.filter(item => item.date !== targetDate)); await enqueue(() => Store.deleteDraft(targetDate));
    draftCalories.delete(targetDate); totals();
    if (operationEpoch !== epoch) return;
    if (targetDate === date) { session += 1; cancelAll(); renderEntry({ date, mealPhotos: {}, mealCalories: {} }); }
    toast(`${targetDate} 的记录已删除。`, async () => {
      await mutate(items => { if (items.some(item => item.date === targetDate)) throw new Error('该日期已有新记录，未覆盖当前内容。'); return [...items, original]; });
      if (oldDraft && !await enqueue(() => Store.readDraft(targetDate))) { await enqueue(() => Store.writeDraft(targetDate, oldDraft)); draftCalories.set(targetDate, Core.sumCalories(oldDraft)); }
      if (targetDate === date && !dirty) await loadDate(date); totals(); toast('整天记录已恢复，已有的新草稿已保留。');
    });
  }
  function history() {
    const query = $('searchInput').value.trim().toLowerCase();
    const visible = sort(records).filter(item => [item.date, item.exercise, item.notes, item.mood].join(' ').toLowerCase().includes(query));
    $('historyList').replaceChildren(); $('recordCount').textContent = records.length; $('emptyState').hidden = visible.length > 0;
    $('emptyState').textContent = records.length && query ? '没有找到匹配的记录。' : '还没有记录。先拍下今天的一餐吧。';
    visible.forEach(item => {
      const article = element('article', 'history-item'), head = element('div', 'history-item-head'), title = element('div', 'history-date'), actions = element('div', 'item-actions');
      title.append(element('strong', '', item.date), element('span', 'mood-pill', item.mood || '平稳'));
      actions.append(button('编辑', 'text-button', async () => { await loadDate(item.date); $('entryForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); }), button('删除整天', 'text-button danger', () => removeDay(item.date))); head.append(title, actions);
      const metrics = element('div', 'history-metrics');
      [present(item.weight) ? `体重 ${item.weight} kg` : '未填体重', `${Core.sumCalories(item)} kcal${!item.mealCalories && present(item.legacyCalories) ? '（旧版总热量）' : ''}`, present(item.water) ? `饮水 ${item.water} ml` : '未填饮水'].forEach(text => metrics.append(element('span', '', text)));
      const photos = element('div', 'history-photos');
      MEALS.forEach(([meal, label]) => {
        if (!safePhoto(item.mealPhotos?.[meal])) return;
        const figure = element('figure'), image = document.createElement('img'); image.src = item.mealPhotos[meal]; image.alt = `${item.date} ${label}`; image.loading = 'lazy';
        const preview = button('', 'history-photo-button', () => showPhoto(item.mealPhotos[meal], image.alt)); preview.setAttribute('aria-label', `放大 ${image.alt}照片`); preview.append(image);
        const remove = button('删除', 'history-remove', () => removeHistoryPhoto(item.date, meal)); remove.setAttribute('aria-label', `删除 ${item.date} ${label}照片`);
        figure.append(preview, remove, element('figcaption', '', `${label}${present(item.mealCalories?.[meal]) ? ` · ${item.mealCalories[meal]} kcal` : ''}`)); photos.append(figure);
      });
      if (!photos.children.length) photos.append(element('p', 'no-photos', '这一天没有餐食照片'));
      article.append(head, metrics, photos);
      const extra = [item.exercise ? `运动：${item.exercise}` : '', item.notes ? `备注：${item.notes}` : ''].filter(Boolean).join('\n'); if (extra) article.append(element('p', 'history-extra', extra));
      $('historyList').append(article);
    });
  }
  function chart() {
    const canvas = $('weightChart'), ctx = canvas.getContext('2d'); if (!ctx) return;
    const today = Core.todayISO();
    const data = sort(records).filter(item => item.date <= today && present(item.weight) && Number(item.weight) > 0).slice(0, 14).reverse();
    const width = canvas.width, height = canvas.height, left = 58, right = width - 30, top = 35, bottom = height - 45;
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    if (data.length < 2) { ctx.fillStyle = '#7b897c'; ctx.font = '22px Microsoft YaHei,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('记录两次体重后，查看变化趋势', width / 2, height / 2); return; }
    const values = data.map(item => Number(item.weight)), min = Math.min(...values) - 0.6, max = Math.max(...values) + 0.6;
    ctx.font = '18px Microsoft YaHei,sans-serif'; ctx.textAlign = 'right'; ctx.lineWidth = 1;
    for (let index = 0; index < 4; index += 1) { const y = top + index * (bottom - top) / 3; ctx.strokeStyle = '#e3e9df'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = '#8a978c'; ctx.fillText((max - index * (max - min) / 3).toFixed(1), left - 9, y + 6); }
    const points = values.map((value, index) => ({ x: left + index * (right - left) / (values.length - 1), y: bottom - (value - min) * (bottom - top) / (max - min) }));
    ctx.strokeStyle = '#2f7d5c'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
    points.forEach((point, index) => { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); if (!index || index === points.length - 1) { ctx.fillStyle = '#365541'; ctx.textAlign = index === 0 ? 'left' : 'right'; ctx.fillText(`${values[index]} kg`, point.x, Math.max(22, point.y - 14)); } });
    ctx.fillStyle = '#8a978c'; ctx.textAlign = 'left'; ctx.fillText(data[0].date.slice(5), left, height - 12); ctx.textAlign = 'right'; ctx.fillText(data.at(-1).date.slice(5), right, height - 12);
    canvas.setAttribute('aria-label', `最近 ${data.length} 次体重，从 ${values[0]} 到 ${values.at(-1)} 千克`);
  }
  function refresh() {
    const today = Core.todayISO(); $('date').max = today;
    $('todayLabel').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    $('formTitle').textContent = date === today ? '今日打卡' : `${date} 打卡`;
    $('calorieDateLabel').textContent = `${date === today ? '今日' : date}已记录热量`;
    $('streakDays').textContent = `${Core.calculateStreak(records, today)} 天`;
    $('weekCount').textContent = `${new Set(records.filter(item => item.date <= today && Core.sameWeek(item.date, today)).map(item => item.date)).size} 天`;
    const latest = sort(records).find(item => item.date <= today && present(item.weight)); $('latestWeight').textContent = latest ? `${latest.weight} kg` : '— kg';
    if (latest && present(latest.targetWeight)) { const gap = Number(latest.weight) - Number(latest.targetWeight); $('targetGap').textContent = gap > 0 ? `与目标相差 ${gap.toFixed(1)} kg，按自己的节奏来` : `已到目标附近，与目标相差 ${Math.abs(gap).toFixed(1)} kg`; }
    else $('targetGap').textContent = latest ? '填写目标体重后查看与目标的距离' : '记录体重后查看与目标的距离';
    history(); chart(); totals();
  }
  async function compress(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选用 JPG、PNG 或 WebP 照片，HEIC 可先转为 JPG。');
    if (file.size > 25 * 1024 * 1024) throw new Error('原照片超过 25 MB，请缩小后再上传。');
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => { const result = new Image(); result.onload = () => resolve(result); result.onerror = () => reject(new Error('照片读取失败，请换一张再试。')); result.src = url; });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60000000) throw new Error('照片尺寸过大或内容无效，请缩小后重试。');
      const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight)), canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器暂时无法处理照片，请重新打开页面。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', 0.8); if (!safePhoto(result) || result.length > 4 * 1024 * 1024) throw new Error('照片压缩失败，请选择较小照片。'); return result;
    } finally { URL.revokeObjectURL(url); }
  }
  async function upload(meal, input) {
    const file = input.files?.[0]; input.value = ''; if (!file || !ready || loading || saving) return;
    if ($('date').value !== date || !validDate(date)) throw new Error('请先选择有效日期。');
    cancel(meal); const version = (photoVersions.get(meal) || 0) + 1, activeSession = session; photoVersions.set(meal, version); jobs.set(meal, version); controls(); mealStatus(meal, '照片处理中…');
    try {
      const photo = await compress(file); if (activeSession !== session || photoVersions.get(meal) !== version) return;
      clearPhoto(entry, meal); entry.mealPhotos ||= {}; entry.mealPhotos[meal] = photo; renderMeal(meal); changed();
      // Image processing has finished; AI may run independently while the photo can be saved.
      if (jobs.get(meal) === version) jobs.delete(meal); controls();
      if ($('autoAnalyze').checked) await analyze(meal);
    } catch (error) { if (activeSession === session && photoVersions.get(meal) === version) { mealStatus(meal, error.message, true); throw error; } }
    finally { if (jobs.get(meal) === version) jobs.delete(meal); controls(); }
  }
  function serviceUI() {
    const message = !navigator.onLine ? '当前离线，可手动记录，联网后再识别。' : service.reason; $('serviceStatus').textContent = message; $('serviceStatus').classList.toggle('warning', !service.configured);
    $('aiSummary').textContent = !service.configured && service.checked ? `${message} 照片仍可保存在本机并手动填写热量。` : $('autoAnalyze').checked ? '自动估算已开启：上传照片会发送至 AI 识别服务，结果需要核对。' : '照片仅存于本机；启用 AI 识别后，会将所选照片发送至识别服务。';
  }
  async function checkService() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000); $('serviceStatus').textContent = '正在检查识别服务…';
    try {
      if (location.protocol === 'file:') throw new Error('本地文件预览未启用 AI，部署后可配置识别服务。');
      const response = await fetch(API, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? '当前静态预览未启用 AI 识别服务。' : '当前无法检查识别服务，请稍后重试。');
      const value = await response.json(); if (typeof value.configured !== 'boolean') throw new Error('当前静态预览未启用 AI 识别服务。');
      service = { checked: true, configured: value.configured, reason: value.configured ? '识别服务已配置，填写访问口令后可估算所选照片。' : typeof value.reason === 'string' ? value.reason : '自动识别服务尚未配置。' };
    } catch (error) { service = { checked: true, configured: false, reason: controller.signal.aborted ? '识别服务检查超时，手动记录仍可使用。' : error.message || '识别服务未启用。' }; }
    finally { clearTimeout(timer); serviceUI(); }
  }
  async function analyze(meal) {
    const photo = entry.mealPhotos?.[meal]; if (!photo || !ready || loading || saving) return;
    const startingSession = session;
    if (!navigator.onLine) { mealStatus(meal, '当前离线，请联网后再识别；照片仍可保存。', true); return; }
    if (!service.checked) await checkService();
    if (startingSession !== session || entry.mealPhotos?.[meal] !== photo) return;
    if (!service.configured) { mealStatus(meal, `${service.reason} 可手动填写热量。`, true); return; }
    if (!token) { mealStatus(meal, '请先在“识别设置”中填写访问口令。', true); if (!$('settingsDialog').open) $('settingsDialog').showModal(); return; }
    cancel(meal); const work = { controller: new AbortController(), session, photo, calorieVersion: calorieVersions.get(meal) || 0 }; requests.set(meal, work);
    ui.get(meal).analyze.textContent = '估算中…'; mealStatus(meal, '正在识别食物和份量，可继续填写其他项目…'); controls(); const timer = setTimeout(() => work.controller.abort('timeout'), 30000);
    try {
      const response = await fetch(API, { method: 'POST', signal: work.controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ image: photo, meal, hint: entry.mealHints?.[meal] || '' }) });
      const value = await response.json(); if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '识别未完成，请稍后重试。');
      if (work.session !== session || entry.mealPhotos?.[meal] !== photo || requests.get(meal) !== work || work.calorieVersion !== (calorieVersions.get(meal) || 0)) return;
      if (!value || !Array.isArray(value.foods) || !value.foods.length || !['low', 'medium', 'high'].includes(value.confidence) || typeof value.totalKcal !== 'number' || !Number.isFinite(value.totalKcal) ||
          value.foods.some(food => !food || typeof food.name !== 'string' || !food.name.trim() || typeof food.grams !== 'number' || !Number.isFinite(food.grams) || food.grams <= 0 || typeof food.kcal !== 'number' || !Number.isFinite(food.kcal) || food.kcal < 0)) throw new Error('识别返回格式不完整，请手动记录或重试。');
      const checked = Core.validateRecords([{ date, mealCalories: { [meal]: value.totalKcal }, mealAnalyses: { [meal]: value } }])[0], analysis = checked.mealAnalyses[meal];
      const sum = analysis.foods.reduce((total, food) => total + Number(food.kcal), 0);
      if (!Number.isFinite(sum) || Math.abs(sum - Number(value.totalKcal)) > 5 || !analysis.range || analysis.range.min > sum || analysis.range.max < sum) throw new Error('识别热量合计不一致，请手动记录或重试。');
      calorieMode(); entry.mealCalories[meal] = value.totalKcal; entry.mealCalorieSources[meal] = 'ai'; entry.mealAnalyses ||= {}; entry.mealAnalyses[meal] = analysis;
      renderMeal(meal); ui.get(meal).details.open = true; changed();
    } catch (error) { if (requests.get(meal) === work && work.session === session && entry.mealPhotos?.[meal] === photo) mealStatus(meal, work.controller.signal.aborted ? '识别超时，照片已保留，请重试或手动填写。' : `${error.message} 照片已保留。`, true); }
    finally { clearTimeout(timer); if (requests.get(meal) === work) { requests.delete(meal); ui.get(meal).analyze.textContent = 'AI 估算'; } controls(); }
  }
  function buildMeals() {
    MEALS.forEach(([meal, label, english]) => {
      const card = element('section', 'meal-card'), heading = element('div', 'meal-heading'); heading.append(element('strong', '', label), element('small', '', english));
      const image = document.createElement('img'); image.id = `${meal}Preview`; image.alt = `${label}照片`;
      const preview = button('', 'photo-uploader', () => entry.mealPhotos?.[meal] ? showPhoto(entry.mealPhotos[meal], `${label}照片`) : ui.get(meal).photo.click()); preview.setAttribute('aria-label', `${label}照片，点击上传或放大`);
      const placeholder = element('span', 'photo-placeholder'); placeholder.append(element('b', '', '+'), element('span', '', '拍下这一餐')); preview.append(image, placeholder, element('span', 'photo-zoom-hint', '点击放大 ↗'));
      const content = element('div', 'meal-content'), actions = element('div', 'meal-actions');
      function fileControl(text, suffix, camera) {
        const wrap = element('label', 'small-button', text), input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.id = `${meal}${suffix}`; input.dataset.meal = meal;
        if (camera) input.setAttribute('capture', 'environment'); input.setAttribute('aria-label', `${label}${text}`); on(input, 'change', () => upload(meal, input)); wrap.append(input); actions.append(wrap); return input;
      }
      const photo = fileControl('相册', 'Photo', false), camera = fileControl('拍照', 'Camera', true), remove = button('删除照片', 'small-button remove-photo', () => removeCurrent(meal)); remove.id = `${meal}Delete`; actions.append(remove);
      const calorieLabel = element('label', 'calorie-field', '本餐热量 · kcal'), calorieRow = element('div', 'calorie-row'), calories = document.createElement('input'); calories.id = `${meal}Calories`; calorieLabel.htmlFor = calories.id; calories.type = 'number'; calories.min = '0'; calories.max = '10000'; calories.step = '1'; calories.placeholder = '手动填写'; calories.setAttribute('aria-label', `${label}热量`);
      const analyzeButton = button('AI 估算', 'analyze-button', () => analyze(meal)); analyzeButton.id = `${meal}Analyze`; calorieRow.append(calories, analyzeButton);
      const mealStatusElement = element('p', 'analysis-status'), hintLabel = element('label', 'food-hint', '份量补充（选填）'), hint = document.createElement('input'); hint.id = `${meal}Hint`; hint.type = 'text'; hint.maxLength = 500; hint.placeholder = '如：米饭半碗、鸡肉约 100 克'; hintLabel.append(hint);
      const details = element('details', 'food-details'), summary = element('summary'), foods = element('div', 'food-rows'), note = element('p', 'food-note'); details.append(summary, foods, note); details.hidden = true;
      content.append(actions, calorieLabel, calorieRow, mealStatusElement, hintLabel, details); card.append(heading, preview, content); $('mealGrid').append(card);
      ui.set(meal, { image, preview, photo, camera, remove, calories, analyze: analyzeButton, status: mealStatusElement, hint, details, summary, foods, note });
      on(calories, 'input', () => { cancel(meal); calorieVersions.set(meal, (calorieVersions.get(meal) || 0) + 1); calorieMode(); entry.mealCalories[meal] = calories.value; entry.mealCalorieSources[meal] = 'manual'; mealStatus(meal, '已手动填写热量，AI 不会覆盖本次修改。'); changed(); controls(); });
      on(hint, 'input', () => { entry.mealHints ||= {}; entry.mealHints[meal] = hint.value; changed(); });
    });
  }
  async function exportData() {
    await queue; if (!ready) throw new Error('本机存储不可用，无法读取备份。'); const saved = Core.validateRecords(await Store.readRecords());
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `每日减脂打卡备份-${Core.todayISO()}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${saved.length} 条已保存记录（含照片）；未保存草稿不在备份中。`);
  }
  async function importData() {
    const file = $('importData').files?.[0]; $('importData').value = ''; if (!file) return; if (file.size > 100 * 1024 * 1024) throw new Error('备份超过 100 MB，请分批恢复。');
    let raw; try { raw = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效的 JSON 文件，本机记录未改变。'); }
    const incoming = Core.validateRecords(raw); if (!incoming.length) { toast('备份中没有记录，本机内容未改变。'); return; }
    await draftNow(); let added = 0, kept = 0;
    await mutate(items => { const dates = new Set(items.map(item => item.date)); incoming.forEach(item => { if (dates.has(item.date)) kept += 1; else { items.push(item); dates.add(item.date); added += 1; } }); return items; });
    if (!dirty) await loadDate(date); toast(`恢复完成：新增 ${added} 天，${kept} 条同日记录保留本机版本。当前未保存草稿已保留。`);
  }
  async function clearAll() {
    if (!confirm('确定清空所有已保存记录、照片和全部本机草稿吗？此操作无法撤销，请先导出备份。')) return;
    clearTimeout(draftTimer); epoch += 1; session += 1; cancelAll(); draftVersions.clear(); saving = true; controls();
    try { const result = await enqueue(() => Store.clearAll()); records = []; draftCalories.clear(); date = Core.todayISO(); dirty = false; renderEntry({ date, mealPhotos: {}, mealCalories: {} }); refresh(); toast(result.legacyCleanupWarning || '记录、照片和草稿已全部清空。'); }
    finally { saving = false; controls(); }
  }
  function network() { $('networkStatus').textContent = navigator.onLine ? '在线 · 本机记录' : '离线 · 本机记录'; serviceUI(); }
  async function initialize() {
    $('autoAnalyze').checked = false;
    $('date').max = Core.todayISO();
    buildMeals(); $('date').value = date; $('todayLabel').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    on($('entryForm'), 'submit', save); FIELDS.forEach(field => on($(field), 'input', () => { entry[field] = $(field).value.trim(); changed(); }));
    on($('date'), 'change', async () => { const selected = $('date').value; if (!validDate(selected)) { cancelAll(); status('日期不能为空，请重新选择日期', true); controls(); totals(); return; } $('date').value = date; await loadDate(selected); });
    on($('searchInput'), 'input', history); on($('exportData'), 'click', exportData); on($('importData'), 'change', importData); on($('clearAll'), 'click', clearAll);
    if ($('importTrigger')) on($('importTrigger'), 'click', () => $('importData').click());
    on($('closeToast'), 'click', () => { $('toast').hidden = true; undo = null; clearTimeout(toastTimer); }); on($('undoAction'), 'click', async () => { const action = undo; undo = null; $('undoAction').hidden = true; if (action) await action(); });
    on($('photoDialog'), 'close', () => $('largePhoto').removeAttribute('src'));
    on($('openSettings'), 'click', async () => { $('accessToken').value = token; $('settingsDialog').showModal(); await checkService(); }); on($('checkService'), 'click', checkService);
    on($('saveSettings'), 'click', () => { token = $('accessToken').value.trim(); $('settingsDialog').close(); toast(token ? '口令已在当前页面生效，关闭页面后需重新填写。' : '未填写口令，可继续手动记录。'); });
    on($('autoAnalyze'), 'change', () => { if ($('autoAnalyze').checked && !confirm('启用后，上传的餐食照片会发送到 AI 识别服务，估算食物、份量和热量。结果需要手动核对。确认启用吗？')) $('autoAnalyze').checked = false; if (!$('autoAnalyze').checked) MEALS.forEach(([meal]) => cancel(meal)); serviceUI(); controls(); });
    on(window, 'online', async () => { network(); await checkService(); }); on(window, 'offline', network);
    on(window, 'beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('installApp').hidden = false; $('installHint').hidden = true; });
    on($('installApp'), 'click', async () => { if (installPrompt) { await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installApp').hidden = true; } });
    on(window, 'appinstalled', () => { installPrompt = null; $('installApp').hidden = true; $('installHint').hidden = true; });
    on(document, 'visibilitychange', async () => { if (document.hidden) await draftNow(); else if (ready) refresh(); });
    window.addEventListener('beforeunload', event => { if (jobs.size || (dirty && revision !== draftedRevision)) { event.preventDefault(); event.returnValue = ''; } });
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) $('installHint').hidden = false;
    network(); controls();
    try { const state = await Store.init(); records = sort(Core.validateRecords(await Store.readRecords())); ready = true; if (state.fallback) { $('storageWarning').hidden = false; $('storageWarning').textContent = '当前使用兼容本机存储，照片容量较小。请定期导出备份；空间不足时不会显示保存成功。'; } await loadDate(date); refresh(); }
    catch (error) { ready = false; $('storageWarning').hidden = false; $('storageWarning').textContent = `本机存储不可用，已暂停写入以保护原记录。${error.message}`; status('存储不可用，无法保存', true); controls(); }
    await checkService();
    if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) { try { await navigator.serviceWorker.register('./sw.js'); } catch { toast('离线缓存尚未就绪，页面内记录仍可使用，请联网后重新打开。'); } }
  }
  initialize().catch(error => { showError(error); ready = false; controls(); });
})();
