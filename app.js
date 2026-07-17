const STORAGE_KEY = "weight-checkin-records-v4";
const OLD_STORAGE_KEYS = [
  "weight-checkin-records-v3",
  "weight-checkin-records-v2",
  "weight-checkin-records-v1",
];
const MEALS = [
  ["breakfast", "早餐"],
  ["lunch", "午餐"],
  ["dinner", "晚餐"],
  ["snacks", "加餐"],
];

const form = document.querySelector("#entryForm");
const historyList = document.querySelector("#historyList");
const emptyState = document.querySelector("#emptyState");
const template = document.querySelector("#historyItemTemplate");
const searchInput = document.querySelector("#searchInput");
const chart = document.querySelector("#weightChart");
const ctx = chart.getContext("2d");
const installButton = document.querySelector("#installApp");
const installHint = document.querySelector("#installHint");

let currentMealPhotos = {};
let currentMealCalories = {};
let deferredInstallPrompt = null;

const fields = [
  "date",
  "weight",
  "targetWeight",
  "water",
  "exercise",
  "mood",
  "notes",
];

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
}

function normalizeEntry(entry) {
  const mealCalories = entry.mealCalories || {};
  const totalCalories = Object.values(mealCalories).reduce((sum, value) => sum + (Number(value) || 0), 0);

  return {
    ...entry,
    mealPhotos: entry.mealPhotos || {},
    mealCalories,
    calories: totalCalories || entry.calories || "",
  };
}

function readRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (records) return records.map(normalizeEntry);

    for (const key of OLD_STORAGE_KEYS) {
      const oldRecords = JSON.parse(localStorage.getItem(key));
      if (oldRecords) return oldRecords.map(normalizeEntry);
    }
  } catch {
    return [];
  }
  return [];
}

function writeRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function getFormData() {
  syncCalories();
  const entry = fields.reduce((result, field) => {
    result[field] = document.querySelector(`#${field}`).value.trim();
    return result;
  }, {});
  entry.mealPhotos = { ...currentMealPhotos };
  entry.mealCalories = { ...currentMealCalories };
  entry.calories = totalCalories() || "";
  return entry;
}

function setPreview(meal, src = "") {
  const preview = document.querySelector(`#${meal}Preview`);
  const uploader = preview.closest(".photo-uploader");
  preview.src = src;
  uploader.classList.toggle("has-photo", Boolean(src));
}

function resetPhotoInputs() {
  MEALS.forEach(([meal]) => {
    document.querySelector(`#${meal}Photo`).value = "";
    document.querySelector(`#${meal}Camera`).value = "";
  });
}

function setFormData(entry = {}) {
  currentMealPhotos = { ...(entry.mealPhotos || {}) };
  currentMealCalories = { ...(entry.mealCalories || {}) };

  fields.forEach((field) => {
    const element = document.querySelector(`#${field}`);
    element.value = entry[field] || "";
  });

  MEALS.forEach(([meal]) => {
    setPreview(meal, currentMealPhotos[meal]);
    document.querySelector(`#${meal}Calories`).value = currentMealCalories[meal] || "";
  });
  resetPhotoInputs();
  if (!entry.date) document.querySelector("#date").value = todayISO();
  if (!entry.mood) document.querySelector("#mood").value = "平稳";
  syncCalories();
}

function sortedRecords(records = readRecords()) {
  return [...records].sort((a, b) => b.date.localeCompare(a.date));
}

function saveEntry(entry) {
  const records = readRecords().filter((item) => item.date !== entry.date);
  records.push({ ...entry, updatedAt: new Date().toISOString() });
  writeRecords(sortedRecords(records));
}

function sameWeek(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  return date >= start;
}

function calculateStreak(records) {
  const dates = new Set(records.map((item) => item.date));
  let streak = 0;
  const cursor = new Date(`${todayISO()}T00:00:00`);
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function totalCalories() {
  return MEALS.reduce((sum, [meal]) => sum + (Number(currentMealCalories[meal]) || 0), 0);
}

function syncCalories() {
  const total = totalCalories();
  document.querySelector("#todayCalories").textContent = `${total} kcal`;
  document.querySelector("#calorieStatus").textContent = `${total} kcal`;
}

function updateStats(records) {
  document.querySelector("#streakDays").textContent = `${calculateStreak(records)} 天`;
  document.querySelector("#weekCount").textContent = `${records.filter((item) => sameWeek(item.date)).length} 天`;

  const latest = sortedRecords(records).find((item) => Number(item.weight) && Number(item.targetWeight));
  const gapEl = document.querySelector("#targetGap");
  const barEl = document.querySelector("#targetBar");

  if (!latest) {
    gapEl.textContent = "--";
    barEl.style.width = "0";
    return;
  }

  const gap = Number(latest.weight) - Number(latest.targetWeight);
  gapEl.textContent = gap > 0 ? `还差 ${gap.toFixed(1)} kg` : `已达标 ${Math.abs(gap).toFixed(1)} kg`;
  const progress = Math.max(8, Math.min(100, 100 - Math.max(0, gap) * 8));
  barEl.style.width = `${progress}%`;
}

function extraSummary(entry) {
  const extras = [];
  if (entry.exercise) extras.push(`运动: ${entry.exercise}`);
  if (entry.notes) extras.push(`备注: ${entry.notes}`);
  return extras.join(" | ");
}

function renderMealPhotos(container, entry) {
  container.innerHTML = "";
  const photos = entry.mealPhotos || {};
  const calories = entry.mealCalories || {};
  const photoMeals = MEALS.filter(([meal]) => photos[meal]);

  if (!photoMeals.length) {
    const empty = document.createElement("p");
    empty.className = "no-photos";
    empty.textContent = "这一天还没有上传餐食照片";
    container.appendChild(empty);
    return;
  }

  photoMeals.forEach(([meal, label]) => {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    const caption = document.createElement("figcaption");
    image.src = photos[meal];
    image.alt = `${label}照片`;
    caption.textContent = calories[meal] ? `${label} ${calories[meal]} kcal` : label;
    figure.append(image, caption);
    container.appendChild(figure);
  });
}

function renderHistory() {
  const records = sortedRecords();
  const query = searchInput.value.trim().toLowerCase();
  const visibleRecords = query
    ? records.filter((entry) => {
        const searchable = [entry.date, entry.exercise, entry.notes, entry.mood].join(" ").toLowerCase();
        return searchable.includes(query);
      })
    : records;

  historyList.innerHTML = "";
  emptyState.hidden = visibleRecords.length > 0;

  visibleRecords.forEach((entry) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('[data-field="date"]').textContent = formatDate(entry.date);
    node.querySelector('[data-field="mood"]').textContent = entry.mood || "平稳";
    node.querySelector('[data-field="weight"]').textContent = entry.weight ? `${entry.weight} kg` : "未填体重";
    node.querySelector('[data-field="calories"]').textContent = entry.calories ? `${entry.calories} kcal` : "未填卡路里";
    node.querySelector('[data-field="water"]').textContent = entry.water ? `${entry.water} ml` : "未填饮水";
    renderMealPhotos(node.querySelector('[data-field="mealPhotos"]'), entry);
    node.querySelector('[data-field="extra"]').textContent = extraSummary(entry);
    node.querySelector('[data-action="edit"]').addEventListener("click", () => {
      setFormData(entry);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    node.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (!confirm(`删除 ${formatDate(entry.date)} 的记录吗？`)) return;
      writeRecords(readRecords().filter((item) => item.date !== entry.date));
      refresh();
    });
    historyList.appendChild(node);
  });
}

function drawChart(records) {
  const data = [...records]
    .filter((entry) => Number(entry.weight))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  const width = chart.width;
  const height = chart.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#ded8cb";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = 32 + i * 54;
    ctx.beginPath();
    ctx.moveTo(42, y);
    ctx.lineTo(width - 18, y);
    ctx.stroke();
  }

  if (data.length < 2) {
    ctx.fillStyle = "#716d63";
    ctx.font = "24px Microsoft YaHei, sans-serif";
    ctx.fillText("记录 2 天以上体重后显示趋势", 112, 138);
    return;
  }

  const weights = data.map((item) => Number(item.weight));
  const min = Math.min(...weights) - 0.6;
  const max = Math.max(...weights) + 0.6;
  const plotLeft = 48;
  const plotRight = width - 24;
  const plotTop = 26;
  const plotBottom = height - 42;

  const pointFor = (entry, index) => {
    const x = plotLeft + (index * (plotRight - plotLeft)) / (data.length - 1);
    const y = plotBottom - ((Number(entry.weight) - min) * (plotBottom - plotTop)) / (max - min || 1);
    return { x, y };
  };

  ctx.strokeStyle = "#2f7d5c";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  data.forEach((entry, index) => {
    const point = pointFor(entry, index);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  data.forEach((entry, index) => {
    const point = pointFor(entry, index);
    ctx.fillStyle = "#fffdf7";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2f7d5c";
    ctx.lineWidth = 3;
    ctx.stroke();

    if (index === data.length - 1 || index === 0) {
      ctx.fillStyle = "#24231f";
      ctx.font = "20px Microsoft YaHei, sans-serif";
      ctx.fillText(`${entry.weight}kg`, point.x - 24, Math.max(22, point.y - 14));
    }
  });

  ctx.fillStyle = "#716d63";
  ctx.font = "18px Microsoft YaHei, sans-serif";
  ctx.fillText(data[0].date.slice(5), plotLeft - 10, height - 12);
  ctx.fillText(data[data.length - 1].date.slice(5), plotRight - 44, height - 12);
}

function refresh() {
  const records = readRecords();
  updateStats(records);
  renderHistory();
  drawChart(records);
}

function exportRecords() {
  const records = readRecords();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `减肥打卡记录-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const image = await loadImage(file);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const canvasContext = canvas.getContext("2d");
  canvasContext.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

async function handleMealPhoto(event) {
  const file = event.target.files[0];
  const meal = event.target.dataset.meal;
  if (!file || !meal) return;

  try {
    const imageData = await compressImage(file);
    currentMealPhotos[meal] = imageData;
    setPreview(meal, imageData);
  } catch {
    alert("这张照片读取失败，请换一张再试。");
  }
}

document.querySelector("#todayLabel").textContent = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const entry = getFormData();
  if (!entry.date) entry.date = todayISO();
  saveEntry(entry);
  refresh();
});

MEALS.forEach(([meal]) => {
  document.querySelector(`#${meal}Photo`).addEventListener("change", handleMealPhoto);
  document.querySelector(`#${meal}Camera`).addEventListener("change", handleMealPhoto);
  document.querySelector(`#${meal}Calories`).addEventListener("input", (event) => {
    currentMealCalories[meal] = event.target.value.trim();
    syncCalories();
  });
});

document.querySelector("#resetToday").addEventListener("click", () => setFormData({ date: todayISO() }));
document.querySelector("#exportData").addEventListener("click", exportRecords);
document.querySelector("#clearAll").addEventListener("click", () => {
  if (!confirm("确定清空所有打卡记录吗？这个操作不能撤销。")) return;
  writeRecords([]);
  refresh();
});
searchInput.addEventListener("input", renderHistory);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
  installHint.hidden = true;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
  installHint.hidden = true;
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js");
}

if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) {
  installHint.hidden = false;
}

setFormData(readRecords().find((entry) => entry.date === todayISO()) || { date: todayISO() });
refresh();
