
const MODES = {
  natural: {
    title: "Natural",
    description: "Естественна дать",
    instruction: "Edit for natural, fluent language. Preserve the author's meaning, level of English, and personal writing style. Avoid clichés and unnecessary rewriting."
  },
  academic: {
    title: "Academic",
    description: "По академски",
    instruction: "Edit into clear academic prose suitable for a university assignment. Improve precision and logical flow without unnecessarily complex vocabulary. Preserve arguments, limitations, citations, quotations, and references. Do not invent sources or evidence."
  },
  professional: {
    title: "Professional",
    description: "Деловой дракон",
    instruction: "Edit into clear, concise professional writing. Preserve the author's intent, factual details, and natural tone."
  }
};

const DAILY_REQUEST_LIMIT = 10;
const DAILY_CHAR_LIMIT = 20000;
const MAX_INPUT_CHARS = 10000;
const TELEGRAM_MESSAGE_LIMIT = 3900;
const GEMINI_TIMEOUT_MS = 45000;

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Telegram text editor is running.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
    const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

    if (!expectedSecret || receivedSecret !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleCallback(update.callback_query, env);
    } catch (error) {
      console.error("Update handling failed:", error?.message || String(error));
    }

    return new Response("OK");
  }
};

async function handleMessage(message, env) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;

  if (!chatId || !userId) return;

  if (!isAllowed(userId, env)) {
    await sendMessage(
      env,
      chatId,
      "Братан, у тебя нет доступа, попроси владельца внести твой айди."
    );
    return;
  }

  const text = (message.text || "").trim();

  if (!text) {
    await sendMessage(
      env,
      chatId,
      "Пока я обрабатываю только текстовые сообщения. Отправь текст прямо в чат."
    );
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(
      env,
      chatId,
      "Салам Аллейкум! Я редактор текстов на русском и английском. Выбери стиль, затем отправь текст.\n\nЯ помогаю улучшать ясность и естественность текста, но не гарантирую результат конкретного AI-детектора.",
      modeKeyboard()
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      env,
      chatId,
      "/start — меню\n/mode — выбрать стиль\n/usage — посмотреть дневной лимит\n/privacy — информация об обработке данных\n\nОтправь текст до 10 000 символов."
    );
    return;
  }

  if (text === "/mode") {
    await sendMessage(env, chatId, "Выбери стиль редактирования:", modeKeyboard());
    return;
  }

  if (text === "/privacy") {
    await sendMessage(
      env,
      chatId,
      "Текст отправляется в Google Gemini API для обработки. Для лимитов хранится счётчик использования за день и выбранный режим. Не отправляй пароли или конфиденциальную информацию."
    );
    return;
  }

  if (text === "/usage") {
    const usage = await getUsage(userId, env);
    await sendMessage(
      env,
      chatId,
      `Сегодня использовано: ${usage.requests}/${DAILY_REQUEST_LIMIT} запросов и ${usage.chars}/${DAILY_CHAR_LIMIT} символов.`
    );
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(env, chatId, "Неизвестная команда. Используй /help.");
    return;
  }

  if (text.length > MAX_INPUT_CHARS) {
    await sendMessage(
      env,
      chatId,
      `Текст слишком длинный (${text.length} символов). Максимум — ${MAX_INPUT_CHARS} символов.`
    );
    return;
  }

  const usage = await getUsage(userId, env);

  if (
    usage.requests >= DAILY_REQUEST_LIMIT ||
    usage.chars + text.length > DAILY_CHAR_LIMIT
  ) {
    await sendMessage(
      env,
      chatId,
      `Дневной лимит достигнут: ${DAILY_REQUEST_LIMIT} запросов и ${DAILY_CHAR_LIMIT} символов. Попробуй завтра.`,
      modeKeyboard()
    );
    return;
  }

  const mode = await getMode(userId, env);
  await sendChatAction(env, chatId, "typing");

  try {
    const edited = await rewriteText(text, mode, env);

    await saveUsage(
      userId,
      usage.requests + 1,
      usage.chars + text.length,
      env
    );

    await sendLongMessage(
      env,
      chatId,
      `Готово · ${MODES[mode].title}\n\n${edited}`
    );

    await sendMessage(
      env,
      chatId,
      "Выбери стиль для следующего текста:",
      modeKeyboard()
    );
  } catch (error) {
    console.error("Rewrite failed:", error?.message || String(error));

    const messageText = error?.name === "AbortError"
      ? "Запрос к Gemini превысил лимит ожидания. Попробуй ещё раз позже."
      : "Не удалось обработать текст. Проверь Cloudflare Logs. Запрос не был засчитан.";

    await sendMessage(env, chatId, messageText);
  }
}

async function handleCallback(query, env) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  if (!userId || !chatId) return;

  if (!isAllowed(userId, env)) {
    await answerCallback(env, query.id, "Нет доступа.");
    return;
  }

  if (data.startsWith("mode:")) {
    const mode = data.slice(5);

    if (!MODES[mode]) {
      await answerCallback(env, query.id, "Неизвестный режим.");
      return;
    }

    await env.USER_DATA.put(
      modeKey(userId),
      mode,
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    await answerCallback(env, query.id, `Выбран режим ${MODES[mode].title}`);

    await sendMessage(
      env,
      chatId,
      `Выбран режим: ${MODES[mode].title} — ${MODES[mode].description}. Теперь отправь текст.`
    );
  }
}

function isAllowed(userId, env) {
  const ids = (env.ALLOWED_TELEGRAM_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  return ids.includes(String(userId));
}

function modeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🌿 Natural", callback_data: "mode:natural" }],
      [{ text: "🎓 Academic", callback_data: "mode:academic" }],
      [{ text: "💼 Professional", callback_data: "mode:professional" }]
    ]
  };
}

function modeKey(userId) {
  return `mode:${userId}`;
}

function usageKey(userId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${userId}`;
}

async function getMode(userId, env) {
  const saved = await env.USER_DATA.get(modeKey(userId));
  return MODES[saved] ? saved : "natural";
}

async function getUsage(userId, env) {
  const raw = await env.USER_DATA.get(usageKey(userId));

  if (!raw) return { requests: 0, chars: 0 };

  try {
    const parsed = JSON.parse(raw);

    return {
      requests: Number(parsed.requests) || 0,
      chars: Number(parsed.chars) || 0
    };
  } catch {
    return { requests: 0, chars: 0 };
  }
}

async function saveUsage(userId, requests, chars, env) {
  await env.USER_DATA.put(
    usageKey(userId),
    JSON.stringify({ requests, chars }),
    { expirationTtl: 60 * 60 * 48 }
  );
}

async function rewriteText(text, mode, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const models = [
    env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash"
  ].filter((model, index, arr) => arr.indexOf(model) === index);

  const systemInstruction = `You are a careful, conservative editor working in the selected style.

Editing style: ${MODES[mode].instruction}

Your goal is to improve the writing while preserving the author's voice.

- Preserve the author's meaning, reasoning, facts, evidence, examples, and level of certainty.
- Make only useful edits; do not rewrite sentences that are already clear.
- Prefer simple, familiar English over unnecessarily advanced vocabulary.
- Avoid generic openings, clichés, formulaic transitions, repetitive sentence patterns, and filler.
- Keep sentence length and structure appropriate to the meaning and the author's existing style.
- Do not make the writing excessively polished, formal, or complicated.
- Preserve understandable original phrasing instead of replacing words with synonyms without a reason.
- Avoid unnecessary stylistic corrections that change the author's voice.
- Correct errors that make the meaning unclear.
- Do not invent statistics, sources, evidence, examples, or personal experiences.
- Preserve citations, quotations, names, numbers, and dates.
- Return only the edited text, without explanations or commentary.
- Preserve the author's natural writing habits, vocabulary, and level of English. Do not overcorrect minor stylistic issues or rewrite sentences that already communicate the intended meaning clearly. Prefer authentic, straightforward language over excessively polished academic prose.
- You can occasionally include specific typos—like accidental double letters—and punctuation errors to lower the AI ​​detection score.`;

  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        GEMINI_TIMEOUT_MS
      );

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: systemInstruction }]
              },
              contents: [
                { role: "user", parts: [{ text }] }
              ],
              generationConfig: {
                maxOutputTokens: 4000
              }
            })
          }
        );

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          const output = (data?.candidates?.[0]?.content?.parts || [])
            .map(part => part.text || "")
            .join("")
            .trim();

          if (output) return output;

          lastError = new Error(
            `Empty response from ${model}: ${
              data?.candidates?.[0]?.finishReason || "unknown"
            }`
          );
          break;
        }

        const message = data?.error?.message || `HTTP ${response.status}`;
        lastError = new Error(`Gemini API ${response.status}: ${message}`);

        if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;

        const statusMatch = error?.message?.match(/Gemini API (\d{3}):/);
        const status = statusMatch ? Number(statusMatch[1]) : null;

        if (
          status !== null &&
          ![408, 429, 500, 502, 503, 504].includes(status)
        ) {
          throw error;
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (attempt < 2) {
        await new Promise(resolve =>
          setTimeout(resolve, 1000 * (2 ** attempt))
        );
      }
    }

    console.warn(`Model ${model} failed; trying next model.`);
  }

  throw lastError || new Error("All Gemini models failed");
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.ok === false) {
    throw new Error(
      result.description || `Telegram API error ${response.status}`
    );
  }

  return result;
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendLongMessage(env, chatId, text) {
  const chunks = splitText(text, TELEGRAM_MESSAGE_LIMIT);

  for (const chunk of chunks) {
    await sendMessage(env, chatId, chunk);
  }
}

function splitText(text, limit) {
  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);

    if (cut < limit * 0.5) {
      cut = rest.lastIndexOf(" ", limit);
    }

    if (cut < limit * 0.5) {
      cut = limit;
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);

  return chunks;
}

async function sendChatAction(env, chatId, action) {
  try {
    await telegramCall(env, "sendChatAction", {
      chat_id: chatId,
      action
    });
  } catch {
    // Non-critical.
  }
}

async function answerCallback(env, callbackQueryId, text) {
  try {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    });
  } catch {
    // Non-critical.
  }
}
