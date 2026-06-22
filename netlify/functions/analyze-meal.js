exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json({}, 204);
  }

  if (event.httpMethod !== "POST") {
    return json({ error: "Only POST is supported" }, 405);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: "AI Key is not configured" }, 501);
  }

  try {
    const { meal, imageData } = JSON.parse(event.body || "{}");
    if (!imageData || !imageData.startsWith("data:image/")) {
      return json({ error: "Missing meal image" }, 400);
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.5",
        max_output_tokens: 350,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  `请根据这张${meal || "餐食"}照片估算总热量。` +
                  "只输出 JSON，不要输出 Markdown。字段为 calories 数字、summary 中文短句、confidence low/medium/high。" +
                  "如果无法判断，也要根据可见食物给出保守估算并说明不确定。不要添加 JSON 外的任何文字。",
              },
              {
                type: "input_image",
                image_url: imageData,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return json({ error: data.error?.message || "AI request failed" }, response.status);
    }

    const text = extractOutputText(data);
    const estimate = parseEstimate(text);
    return json(estimate);
  } catch (error) {
    return json({ error: error.message || "Analyze failed" }, 500);
  }
};

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const content = data.output?.flatMap((item) => item.content || []) || [];
  const textItem = content.find((item) => item.type === "output_text" && item.text);
  return textItem?.text || "";
}

function parseEstimate(text) {
  const cleaned = text
    .replace(/```json|```/g, "")
    .trim()
    .match(/\{[\s\S]*\}/)?.[0];
  if (!cleaned) throw new Error("AI response was not valid JSON");
  const parsed = JSON.parse(cleaned);
  const calories = Math.max(0, Math.round(Number(parsed.calories) || 0));
  return {
    calories,
    summary: parsed.summary || `约 ${calories} kcal`,
    confidence: parsed.confidence || "medium",
  };
}

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
