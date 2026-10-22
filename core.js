(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CheckinCore = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const MEALS = ["breakfast", "lunch", "dinner", "snacks"];
  const DAILY_CALORIE_GOAL = 1800;
  const DAY_MS = 86400000;
  const MAX_PHOTO_LENGTH = 12 * 1024 * 1024;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isBlank = (value) => value === "" || value === null || value === undefined;

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function dayNumber(value) {
    return validDate(value) ? Date.parse(`${value}T00:00:00.000Z`) / DAY_MS : null;
  }

  function todayISO(now = new Date()) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("日期无效，请使用有效日期。");
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const getPart = (type) => parts.find((part) => part.type === type).value;
    return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
  }

  function numericValue(value) {
    if (isBlank(value) || (typeof value !== "number" && typeof value !== "string")) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function sumCalories(entry) {
    if (!isObject(entry)) return 0;
    if (isObject(entry.mealCalories)) {
      const total = MEALS.reduce((sum, meal) => sum + (numericValue(entry.mealCalories[meal]) || 0), 0);
      return Math.round(total * 100) / 100;
    }
    return numericValue(entry.legacyCalories) ?? numericValue(entry.calories) ?? 0;
  }

  function calorieBudget(entry) {
    const consumed = sumCalories(entry);
    return {
      goal: DAILY_CALORIE_GOAL,
      consumed,
      remaining: Math.round(Math.max(0, DAILY_CALORIE_GOAL - consumed) * 100) / 100,
      over: Math.round(Math.max(0, consumed - DAILY_CALORIE_GOAL) * 100) / 100,
    };
  }

  function normalizeEntry(entry) {
    const source = isObject(entry) ? entry : {};
    const result = { ...source, mealPhotos: isObject(source.mealPhotos) ? { ...source.mealPhotos } : {} };
    if (isObject(source.mealCalories)) {
      result.mealCalories = { ...source.mealCalories };
      result.calories = sumCalories(source);
    } else {
      delete result.mealCalories;
      const legacy = numericValue(source.legacyCalories) ?? numericValue(source.calories);
      if (legacy !== null) result.legacyCalories = legacy;
      result.calories = legacy === null ? "" : legacy;
    }
    return result;
  }

  function calculateStreak(records, today = todayISO()) {
    const current = dayNumber(today);
    if (current === null) throw new Error("统计日期无效。");
    const days = new Set((Array.isArray(records) ? records : []).map((record) => dayNumber(record && record.date)).filter((day) => day !== null && day <= current));
    let cursor = days.has(current) ? current : current - 1;
    let streak = 0;
    while (days.has(cursor)) {
      streak += 1;
      cursor -= 1;
    }
    return streak;
  }

  function sameWeek(dateString, today = todayISO()) {
    const current = dayNumber(today);
    if (current === null) throw new Error("统计日期无效。");
    const candidate = dayNumber(dateString);
    if (candidate === null) return false;
    const weekday = new Date(current * DAY_MS).getUTCDay();
    const monday = current - ((weekday + 6) % 7);
    return candidate >= monday && candidate <= monday + 6;
  }

  function fail(label, reason) {
    throw new Error(`${label}${reason}。`);
  }

  function cleanText(value, label, maxLength) {
    if (isBlank(value)) return "";
    if (typeof value !== "string") fail(label, "必须是文字");
    if (value.length > maxLength) fail(label, `不能超过 ${maxLength} 个字符`);
    return value;
  }

  function cleanNumber(value, label, minimum, maximum) {
    if (isBlank(value) || (typeof value === "string" && value.trim() === "")) return "";
    if (typeof value !== "number" && typeof value !== "string") fail(label, "必须是数字");
    if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) fail(label, "必须是有效数字");
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) fail(label, `必须在 ${minimum} 至 ${maximum} 之间`);
    return number;
  }

  function prefixBytes(base64) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = [];
    let bits = 0;
    let bitCount = 0;
    for (const character of base64.slice(0, 24)) {
      if (character === "=") break;
      bits = (bits << 6) | alphabet.indexOf(character);
      bitCount += 6;
      if (bitCount >= 8) {
        bitCount -= 8;
        bytes.push((bits >> bitCount) & 255);
      }
    }
    return bytes;
  }

  function cleanPhoto(value, label) {
    if (isBlank(value)) return "";
    if (typeof value !== "string" || value.length > MAX_PHOTO_LENGTH) fail(label, "不是有效照片或照片过大");
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) fail(label, "只支持安全的 JPEG、PNG 或 WebP 照片");
    const bytes = prefixBytes(match[2]);
    const hasPrefix = (expected, offset = 0) => expected.every((byte, index) => bytes[offset + index] === byte);
    const valid = match[1] === "jpeg" ? hasPrefix([255, 216, 255])
      : match[1] === "png" ? hasPrefix([137, 80, 78, 71, 13, 10, 26, 10])
        : hasPrefix([82, 73, 70, 70]) && hasPrefix([87, 69, 66, 80], 8);
    if (!valid) fail(label, "内容与照片格式不符");
    return value;
  }

  function mealObject(value, label, cleanValue) {
    if (!isObject(value)) fail(label, "格式错误");
    const result = {};
    MEALS.forEach((meal) => {
      if (own(value, meal)) result[meal] = cleanValue(value[meal], `${label}（${meal}）`);
    });
    return result;
  }

  function cleanAnalysis(value, label) {
    if (!isObject(value)) fail(label, "格式错误");
    const result = {};
    if (own(value, "foods")) {
      if (!Array.isArray(value.foods) || value.foods.length > 50) fail(label, "食物列表格式错误或超过 50 项");
      result.foods = value.foods.map((food) => {
        if (!isObject(food)) fail(label, "食物项目格式错误");
        const item = { name: cleanText(food.name, `${label}食物名称`, 120) };
        if (!item.name.trim()) fail(label, "食物名称不能为空");
        if (own(food, "grams")) item.grams = cleanNumber(food.grams, `${label}食物克数`, 0, 20000);
        if (own(food, "kcal")) item.kcal = cleanNumber(food.kcal, `${label}食物热量`, 0, 10000);
        return item;
      });
    }
    if (own(value, "totalKcal")) result.totalKcal = cleanNumber(value.totalKcal, `${label}总热量`, 0, 10000);
    if (own(value, "range")) {
      if (!isObject(value.range)) fail(label, "热量范围格式错误");
      const min = cleanNumber(value.range.min, `${label}热量下限`, 0, 10000);
      const max = cleanNumber(value.range.max, `${label}热量上限`, 0, 10000);
      if (min === "" || max === "" || min > max) fail(label, "热量范围无效");
      result.range = { min, max };
    }
    if (own(value, "confidence")) {
      result.confidence = typeof value.confidence === "number"
        ? cleanNumber(value.confidence, `${label}识别置信度`, 0, 1)
        : cleanText(value.confidence, `${label}识别置信度`, 40);
    }
    if (own(value, "notes")) result.notes = cleanText(value.notes, `${label}备注`, 5000);
    if (own(value, "photoVersion")) result.photoVersion = cleanText(value.photoVersion, `${label}照片版本`, 200);
    return result;
  }

  function validateRecords(input) {
    if (!Array.isArray(input)) throw new Error("备份格式错误，应为每日记录数组。");
    if (input.length > 5000) throw new Error("备份最多支持 5000 条记录。");
    return input.map((entry, index) => {
      const label = `第 ${index + 1} 条记录`;
      if (!isObject(entry)) fail(label, "格式错误");
      if (!validDate(entry.date)) fail(`${label}日期`, "无效，请使用真实的 YYYY-MM-DD 日期");
      const result = { date: entry.date };
      ["weight", "targetWeight"].forEach((field) => {
        if (own(entry, field)) result[field] = cleanNumber(entry[field], `${label}${field === "weight" ? "体重" : "目标体重"}`, 20, 300);
      });
      if (own(entry, "water")) result.water = cleanNumber(entry.water, `${label}饮水量`, 0, 10000);
      [["mood", "心情", 100], ["exercise", "运动", 1000], ["notes", "备注", 10000]].forEach(([field, name, limit]) => {
        if (own(entry, field)) result[field] = cleanText(entry[field], `${label}${name}`, limit);
      });
      if (own(entry, "updatedAt")) result.updatedAt = cleanText(entry.updatedAt, `${label}更新时间`, 100);
      if (own(entry, "mealPhotos") && entry.mealPhotos !== null) result.mealPhotos = mealObject(entry.mealPhotos, `${label}照片`, cleanPhoto);
      if (own(entry, "mealCalories") && entry.mealCalories !== null) {
        result.mealCalories = mealObject(entry.mealCalories, `${label}每餐热量`, (value, name) => cleanNumber(value, name, 0, 10000));
      }
      if (own(entry, "legacyCalories")) result.legacyCalories = cleanNumber(entry.legacyCalories, `${label}旧版总热量`, 0, 40000);
      if (!isObject(entry.mealCalories) && own(entry, "calories")) result.calories = cleanNumber(entry.calories, `${label}总热量`, 0, 40000);
      if (own(entry, "mealAnalyses") && entry.mealAnalyses !== null) result.mealAnalyses = mealObject(entry.mealAnalyses, `${label}识别结果`, cleanAnalysis);
      if (own(entry, "mealHints") && entry.mealHints !== null) {
        result.mealHints = mealObject(entry.mealHints, `${label}份量补充`, (value, name) => cleanText(value, name, 500));
      }
      if (own(entry, "mealCalorieSources") && entry.mealCalorieSources !== null) {
        result.mealCalorieSources = mealObject(entry.mealCalorieSources, `${label}热量来源`, (value, name) => {
          if (value !== "ai" && value !== "manual") fail(name, "只能是 ai 或 manual");
          return value;
        });
      }
      return normalizeEntry(result);
    });
  }

  return { todayISO, normalizeEntry, calculateStreak, sameWeek, validateRecords, sumCalories, DAILY_CALORIE_GOAL, calorieBudget };
});
